// m6-fix-undeclared-state-transitions: the 8 failure transitions to
// cleanup_pending introduced by the t24 production-wiring fix must be declared
// in the authoritative state-and-lifecycle contract (md + json) and visible to
// citadel's PRD-declared transition set so the audit no longer reports them as
// HIGH state-transition:undeclared findings.
//
// The t24 production-wiring fix replaced fabricated success-phase transitions
// with true failure edges: every pre-cleanup state has a legal direct edge to
// cleanup_pending.  These edges are already declared in the JSON contract and
// the PHASE_TRANSITION_TABLE, but were missing from the markdown contract and
// MISSION_3_PRD.md, causing citadel's state-transition analyzer to flag them
// as undeclared when discovered in code comments and test assertions.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCitadelPrd } from "../../src/lifecycle/citadel/prd-audit-parser.js";

const orchestratorRoot = join(import.meta.dirname, "../..");
const repoRoot = join(orchestratorRoot, "..");
const contractJsonPath = join(repoRoot, "docs/architecture/reliability/state-and-lifecycle-contract.json");
const contractMdPath = join(repoRoot, "docs/architecture/reliability/state-and-lifecycle-contract.md");
const prdPath = join(repoRoot, "MISSION_3_PRD.md");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const contract: any = JSON.parse(readFileSync(contractJsonPath, "utf8"));
const contractMd = readFileSync(contractMdPath, "utf8");
const prdMd = readFileSync(prdPath, "utf8");

/**
 * The 8 failure transitions introduced by the t24 production-wiring fix.
 * Every pre-cleanup state has a legal direct edge to cleanup_pending with
 * failureTarget "failed_clean".  These replace the fabricated success-phase
 * transitions that were used before the fix.
 */
const FAILURE_EDGES: ReadonlyArray<{ from: string; to: string; owner: string }> = [
  { from: "planned", to: "cleanup_pending", owner: "AttemptLifecycleService" },
  { from: "implementing", to: "cleanup_pending", owner: "AttemptLifecycleService" },
  { from: "implementation_captured", to: "cleanup_pending", owner: "AttemptLifecycleService" },
  { from: "reviewing", to: "cleanup_pending", owner: "ReviewService" },
  { from: "remediating", to: "cleanup_pending", owner: "RemediationService" },
  { from: "remediation_captured", to: "cleanup_pending", owner: "RemediationService" },
  { from: "verification_queued", to: "cleanup_pending", owner: "VerificationService" },
  { from: "verifying", to: "cleanup_pending", owner: "VerificationService" },
];

describe("m6 failure transition declaration (citadel fix)", () => {
  it("declares all 8 failure transitions in the JSON contract with owner and guard", () => {
    const attemptEdges = contract.state_machines.attempt.edges as Array<{
      from: string; to: string; owner: string; guard: string;
    }>;
    for (const expected of FAILURE_EDGES) {
      const edge = attemptEdges.find(
        (e) => e.from === expected.from && e.to === expected.to,
      );
      expect(edge, `JSON contract must declare ${expected.from} to ${expected.to}`).toBeDefined();
      expect(edge!.owner).toBe(expected.owner);
      expect(edge!.guard.length).toBeGreaterThan(0);
    }
  });

  it("declares all 8 failure transitions in the markdown contract with arrow syntax citadel can parse", () => {
    // citadel's extractTransitions scans for arrow-delimited identifier tokens.
    // Each failure edge must appear in the contract markdown with the exact
    // arrow syntax (from, arrow, to) so citadel's declared transition set
    // includes it.
    for (const expected of FAILURE_EDGES) {
      const arrowPattern = new RegExp(`${expected.from}\\s*->\\s*${expected.to}`);
      expect(
        contractMd,
        `contract.md must contain arrow syntax for ${expected.from} to ${expected.to}`,
      ).toMatch(arrowPattern);
    }
  });

  it("names the owning authorities for the failure transitions in the markdown contract", () => {
    // The owning authorities must be documented alongside the declaration.
    for (const expected of FAILURE_EDGES) {
      expect(contractMd).toContain(expected.owner);
    }
  });

  it("declares all 8 failure transitions in MISSION_3_PRD.md with arrow syntax", () => {
    // The PRD itself must also declare the failure transitions so the
    // citadel-declared set includes them even if the composes graph is not
    // traversed.
    for (const expected of FAILURE_EDGES) {
      const arrowPattern = new RegExp(`${expected.from}\\s*->\\s*${expected.to}`);
      expect(
        prdMd,
        `MISSION_3_PRD.md must contain arrow syntax for ${expected.from} to ${expected.to}`,
      ).toMatch(arrowPattern);
    }
  });

  it("exposes all 8 failure transitions to citadel via the PRD composes graph", () => {
    // The PRD composes the state-and-lifecycle contract so citadel's declared
    // transition set includes the 8 failure edges, resolving the 5 HIGH
    // state-transition:undeclared findings.
    const parsed = parseCitadelPrd(prdPath, repoRoot);
    const declared = new Set(
      parsed.transitions.map((t) => t.toUpperCase().replace(/\s+/g, "")),
    );
    for (const expected of FAILURE_EDGES) {
      const key = `${expected.from.toUpperCase()}->${expected.to.toUpperCase()}`;
      expect(
        declared.has(key),
        `citadel declared set must include ${key}`,
      ).toBe(true);
    }
  });
});
