// t22A fix: the two state transitions flagged by the citadel state-transition
// analyzer (HELD->CLOSED_NEVER_RELEASED at store.ts:2285 and
// LIVE->CLEANUP_PENDING at disposition-store-bridge.test.ts:283) must be
// declared in the authoritative state-and-lifecycle contract (md + json) with
// the exact source/target states, owning authority, and precondition, and must
// be visible to citadel's PRD-declared transition set so the audit no longer
// reports them as HIGH state-transition:undeclared.

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

interface DeclaredEdge {
  from: string;
  to: string;
  owner: string;
  precondition: string;
}

function ownershipTableContract(): Record<string, unknown> {
  return contract.resource_identity.ownership_table_contract as Record<string, unknown>;
}

function edgesOf(table: Record<string, unknown>): DeclaredEdge[] {
  const edges = table.edges;
  if (!Array.isArray(edges)) {
    throw new Error("expected an edges array on the contract table entry");
  }
  return edges as DeclaredEdge[];
}

function findEdge(edges: DeclaredEdge[], from: string, to: string): DeclaredEdge {
  const edge = edges.find((entry) => entry.from === from && entry.to === to);
  if (edge === undefined) {
    throw new Error(`declared edge ${from}->${to} not found`);
  }
  return edge;
}

describe("t22A declared state transitions (citadel fix)", () => {
  it("declares HELD->CLOSED_NEVER_RELEASED in the json contract with owner and precondition", () => {
    const gate = ownershipTableContract().target_start_gates as Record<string, unknown>;
    const neverReleased = findEdge(edgesOf(gate), "held", "closed_never_released");
    expect(neverReleased.owner).toBe("TargetStartGateAuthority");
    expect(neverReleased.precondition.length).toBeGreaterThan(0);
    // The declared edge must still require an authority-minted receipt and fail
    // closed on missing evidence (no invariant weakened).
    expect(neverReleased.precondition).toMatch(/LeaseAuthority-branded mint capability/);
  });

  it("declares HELD->RELEASED in the json contract with owner and precondition", () => {
    const gate = ownershipTableContract().target_start_gates as Record<string, unknown>;
    const released = findEdge(edgesOf(gate), "held", "released");
    expect(released.owner).toBe("TargetStartGateAuthority");
    expect(released.precondition.length).toBeGreaterThan(0);
  });

  it("declares LIVE->CLEANUP_PENDING in the json contract with owner and precondition", () => {
    const leases = ownershipTableContract().attempt_ownership_leases as Record<string, unknown>;
    const liveToCleanup = findEdge(edgesOf(leases), "live", "cleanup_pending");
    expect(liveToCleanup.owner).toBe("LeaseService");
    expect(liveToCleanup.precondition.length).toBeGreaterThan(0);
  });

  it("declares the two transitions in the markdown contract with arrows citadel can parse", () => {
    // citadel's extractTransitions scans for `->` / `→` arrow-delimited
    // identifier tokens; the contract.md must contain both edges.
    expect(contractMd).toMatch(/held\s*->\s*closed_never_released/);
    expect(contractMd).toMatch(/live\s*->\s*cleanup_pending/);
    // The owning authorities must be named alongside the declaration.
    expect(contractMd).toContain("TargetStartGateAuthority");
    expect(contractMd).toContain("LeaseService");
  });

  it("exposes both declared transitions to citadel via the PRD composes graph", () => {
    // The PRD must compose the state-and-lifecycle contract so citadel's
    // declared transition set includes the two edges, resolving the two HIGH
    // state-transition:undeclared findings.
    const prd = readFileSync(prdPath, "utf8");
    expect(prd).toMatch(/composes:/);
    const parsed = parseCitadelPrd(prdPath, repoRoot);
    const declared = new Set(parsed.transitions.map((t) => t.toUpperCase().replace(/\s+/g, "")));
    expect(declared.has("HELD->CLOSED_NEVER_RELEASED")).toBe(true);
    expect(declared.has("LIVE->CLEANUP_PENDING")).toBe(true);
  });
});
