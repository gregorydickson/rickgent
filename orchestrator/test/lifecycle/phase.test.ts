import { describe, it, expect } from "vitest";
import {
  PHASE_TABLE_VERSION,
  PHASE_STATES,
  PHASE_TERMINAL_STATES,
  PHASE_TRANSITION_TABLE,
  isLegalPhaseEdge,
  isTerminalPhase,
  legalPhaseEdge,
  phaseEdgesFrom,
  type PhaseState,
} from "../../src/lifecycle/phase.js";

// t24: the normative phase/remediation transition table.
// The boolean 8-phase scaffold (PHASES, shouldAdvance, nextPhase, isTerminal)
// has been replaced by one versioned typed transition table.  These tests
// verify the table's structure and helpers.

describe("normative phase transition table (t24)", () => {
  it("is versioned and frozen", () => {
    expect(PHASE_TABLE_VERSION).toBe("rickgent.phase-table.v1");
    expect(Object.isFrozen(PHASE_STATES)).toBe(true);
    expect(Object.isFrozen(PHASE_TERMINAL_STATES)).toBe(true);
    expect(Object.isFrozen(PHASE_TRANSITION_TABLE)).toBe(true);
  });

  it("declares the normative attempt lifecycle states (not the boolean 8-phase scaffold)", () => {
    expect(PHASE_STATES).toContain("planned");
    expect(PHASE_STATES).toContain("implementing");
    expect(PHASE_STATES).toContain("implementation_captured");
    expect(PHASE_STATES).toContain("reviewing");
    expect(PHASE_STATES).toContain("remediating");
    expect(PHASE_STATES).toContain("remediation_captured");
    expect(PHASE_STATES).toContain("verification_queued");
    expect(PHASE_STATES).toContain("verifying");
    expect(PHASE_STATES).toContain("converging");
    expect(PHASE_STATES).toContain("cleanup_pending");
    expect(PHASE_STATES).toContain("oracle_evaluation");
    expect(PHASE_STATES).toContain("verified");
    expect(PHASE_STATES).toContain("failed_clean");
    expect(PHASE_STATES).toContain("quarantined");
    // The boolean scaffold states must NOT be present.
    expect(PHASE_STATES).not.toContain("research");
    expect(PHASE_STATES).not.toContain("simplify");
    expect(PHASE_STATES).not.toContain("implement");
  });

  it("declares the forward success chain planned -> ... -> verified", () => {
    const forwardChain: ReadonlyArray<readonly [PhaseState, PhaseState]> = [
      ["planned", "implementing"],
      ["implementing", "implementation_captured"],
      ["implementation_captured", "reviewing"],
      ["reviewing", "verification_queued"],
      ["verification_queued", "verifying"],
      ["verifying", "converging"],
      ["converging", "cleanup_pending"],
      ["cleanup_pending", "oracle_evaluation"],
      ["oracle_evaluation", "verified"],
    ];
    for (const [from, to] of forwardChain) {
      expect(isLegalPhaseEdge(from, to)).toBe(true);
    }
  });

  it("declares the remediation loop reviewing -> remediating -> remediation_captured -> reviewing", () => {
    expect(isLegalPhaseEdge("reviewing", "remediating")).toBe(true);
    expect(isLegalPhaseEdge("remediating", "remediation_captured")).toBe(true);
    expect(isLegalPhaseEdge("remediation_captured", "reviewing")).toBe(true);
  });

  it("declares failure edges from every pre-cleanup state to cleanup_pending", () => {
    const preCleanup: readonly PhaseState[] = [
      "planned", "implementing", "implementation_captured", "reviewing",
      "remediating", "remediation_captured", "verification_queued", "verifying",
      "converging",
    ];
    for (const from of preCleanup) {
      expect(isLegalPhaseEdge(from, "cleanup_pending")).toBe(true);
    }
  });

  it("declares cleanup terminal edges", () => {
    expect(isLegalPhaseEdge("cleanup_pending", "failed_clean")).toBe(true);
    expect(isLegalPhaseEdge("cleanup_pending", "quarantined")).toBe(true);
  });

  it("rejects illegal edges not in the table", () => {
    expect(isLegalPhaseEdge("planned", "reviewing")).toBe(false);
    expect(isLegalPhaseEdge("planned", "verified")).toBe(false);
    expect(isLegalPhaseEdge("reviewing", "verified")).toBe(false);
    expect(isLegalPhaseEdge("verified", "planned")).toBe(false);
    expect(isLegalPhaseEdge("failed_clean", "planned")).toBe(false);
  });

  it("isTerminalPhase classifies terminal states", () => {
    expect(isTerminalPhase("verified")).toBe(true);
    expect(isTerminalPhase("failed_clean")).toBe(true);
    expect(isTerminalPhase("quarantined")).toBe(true);
    expect(isTerminalPhase("planned")).toBe(false);
    expect(isTerminalPhase("cleanup_pending")).toBe(false);
  });

  it("phaseEdgesFrom returns outgoing legal edges", () => {
    const fromReviewing = phaseEdgesFrom("reviewing");
    const targets = fromReviewing.map((e) => e.to);
    expect(targets).toContain("verification_queued");
    expect(targets).toContain("remediating");
    expect(targets).toContain("cleanup_pending");
    expect(phaseEdgesFrom("verified")).toHaveLength(0);
    expect(phaseEdgesFrom("failed_clean")).toHaveLength(0);
  });

  it("every edge declares a guard, evidence producer, and role", () => {
    for (const edge of PHASE_TRANSITION_TABLE) {
      expect(edge.guard.length).toBeGreaterThan(0);
      expect(edge.evidenceProducer.length).toBeGreaterThan(0);
      expect(edge.role.length).toBeGreaterThan(0);
    }
  });

  it("legalPhaseEdge returns the edge for legal edges and undefined for illegal", () => {
    const edge = legalPhaseEdge("planned", "implementing");
    expect(edge).toBeDefined();
    expect(edge!.from).toBe("planned");
    expect(edge!.to).toBe("implementing");
    expect(legalPhaseEdge("planned", "verified")).toBeUndefined();
  });
});
