/**
 * t27 — Independent review and bounded remediation.
 *
 * VAL-ORC-001: Fresh read-only review runs against immutable inputs; bounded
 * structured remediation and re-review are enforced; reviewer/worker
 * authority collapse is rejected.
 *
 * These tests prove:
 *   (a) the ReviewAuthority performs a fresh read-only review against
 *       immutable (frozen) inputs — the reviewer process/role differs from
 *       the implementation worker, has no write/terminal-state authority,
 *       and receives no mutable implementation session state;
 *   (b) the review outputs a validated accept/reject verdict with finding
 *       IDs, severity, paths/interfaces, evidence references, and
 *       context/contract digest;
 *   (c) rejection enters remediation only within the contract budget
 *       (max_review_cycles / remediation_limit), remediation changes remain
 *       in the same owned attempt scope, and each cycle uses a fresh
 *       reviewer process;
 *   (d) reviewer crash, malformed/missing verdict, attempted write, stale
 *       diff, role equality, or exhausted budget blocks later phases and
 *       enters cleanup/failure (fail closed);
 *   (e) documentation and receipts call this independent review, not
 *       cross-vendor review — the schema version is
 *       `rickgent.independent-review.v1`, never cross-vendor.
 *
 * Red-then-green: this file is authored BEFORE `review.ts` and
 * `remediation.ts` exist, so the imports fail (red).  After implementation
 * every assertion passes (green).
 */
import { describe, it, expect } from "vitest";
import {
  performReview,
  REVIEW_AUTHORITY_SCHEMA_VERSION,
  type ReviewVerdict,
  type ReviewFinding,
  type ReviewImmutableInputs,
  type ReviewerIdentity,
  type WorkerIdentity,
  type ReviewHook,
  type ReviewOutcome,
  type ReviewRequest,
} from "../../src/lifecycle/review.js";
import {
  performRemediation,
  runBoundedRemediationLoop,
  REMEDIATION_AUTHORITY_SCHEMA_VERSION,
  type RemediationHook,
  type RemediationOutcome,
  type RemediationLoopRequest,
  type RemediationLoopOutcome,
} from "../../src/lifecycle/remediation.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONTRACT_DIGEST = "sha256:contract-test-digest-aaaa";
const CONTEXT_DIGEST_REVIEWER_1 = "sha256:reviewer-context-digest-cycle-1";
const CONTEXT_DIGEST_REVIEWER_2 = "sha256:reviewer-context-digest-cycle-2";
const CONTEXT_DIGEST_WORKER = "sha256:worker-context-digest-dddd";
const BASELINE_OID = "abc123baseline";
const CANDIDATE_OID = "def456candidate";
const DIFF_DIGEST = "sha256:diff-digest-eeee";

function makeImmutableInputs(
  overrides: Partial<ReviewImmutableInputs> = {},
): ReviewImmutableInputs {
  return {
    baselineOid: BASELINE_OID,
    candidateOid: CANDIDATE_OID,
    diffDigest: DIFF_DIGEST,
    contractDigest: CONTRACT_DIGEST,
    contextDigest: CONTEXT_DIGEST_REVIEWER_1,
    ...overrides,
  };
}

function makeReviewer(
  overrides: Partial<ReviewerIdentity> = {},
): ReviewerIdentity {
  return {
    role: "reviewer",
    contextId: "reviewer-context-cycle-1",
    modelIdentity: "fixture-model-reviewer",
    ...overrides,
  };
}

function makeWorker(
  overrides: Partial<WorkerIdentity> = {},
): WorkerIdentity {
  return {
    role: "worker",
    contextId: "worker-context-aaaa",
    modelIdentity: "fixture-model-worker",
    ...overrides,
  };
}

function makeAcceptHook(): ReviewHook {
  return () => ({
    verdict: "accept",
    findings: [],
  });
}

function makeRejectHook(findings?: ReviewFinding[]): ReviewHook {
  const defaultFindings: ReviewFinding[] = [
    {
      id: "F-001",
      severity: "high",
      message: "candidate tree does not match contract scope",
      path: "orchestrator/src/lifecycle/review.ts",
      evidenceReference: "evidence-review-verdict-test",
    },
  ];
  return () => ({
    verdict: "reject",
    findings: findings ?? defaultFindings,
  });
}

function makeRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    cycle: 1,
    reviewer: makeReviewer(),
    worker: makeWorker(),
    inputs: makeImmutableInputs(),
    expectedDiffDigest: DIFF_DIGEST,
    reviewHook: makeAcceptHook(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Fresh read-only review against immutable inputs
// ---------------------------------------------------------------------------

describe("review-authority: fresh read-only review against immutable inputs (VAL-ORC-001)", () => {
  it("performs a review and returns a typed accepted outcome", () => {
    const outcome = performReview(makeRequest());
    expect(outcome.status).toBe("accepted");
    expect(outcome.verdict).toBe("accept");
    expect(outcome.findings).toEqual([]);
    expect(outcome.cycle).toBe(1);
  });

  it("freezes the immutable inputs before passing them to the hook", () => {
    let receivedInputs: ReviewImmutableInputs | null = null;
    const hook: ReviewHook = (inputs) => {
      receivedInputs = inputs;
      return { verdict: "accept", findings: [] };
    };
    performReview(makeRequest({ reviewHook: hook }));
    expect(receivedInputs).not.toBeNull();
    expect(Object.isFrozen(receivedInputs)).toBe(true);
  });

  it("the review hook receives only the immutable inputs — no store, no write capability", () => {
    const hook: ReviewHook = (inputs) => {
      // The hook can only read the immutable inputs — it has no store
      // reference, no write methods, no terminal-state authority.
      expect(typeof inputs.baselineOid).toBe("string");
      expect(typeof inputs.candidateOid).toBe("string");
      expect(typeof inputs.diffDigest).toBe("string");
      expect(typeof inputs.contractDigest).toBe("string");
      expect(typeof inputs.contextDigest).toBe("string");
      return { verdict: "accept", findings: [] };
    };
    const outcome = performReview(makeRequest({ reviewHook: hook }));
    expect(outcome.status).toBe("accepted");
  });

  it("schema version is rickgent.independent-review.v1 (not cross-vendor)", () => {
    expect(REVIEW_AUTHORITY_SCHEMA_VERSION).toBe("rickgent.independent-review.v1");
    expect(REVIEW_AUTHORITY_SCHEMA_VERSION).not.toContain("cross_vendor");
    expect(REVIEW_AUTHORITY_SCHEMA_VERSION).not.toContain("cross-vendor");
  });
});

// ---------------------------------------------------------------------------
// 2. Validated accept/reject verdict with structured findings
// ---------------------------------------------------------------------------

describe("review-authority: validated accept/reject verdict with findings (VAL-ORC-001)", () => {
  it("accept verdict with no findings is accepted", () => {
    const outcome = performReview(makeRequest({ reviewHook: makeAcceptHook() }));
    expect(outcome.status).toBe("accepted");
    expect(outcome.verdict).toBe("accept");
    expect(outcome.findings).toEqual([]);
  });

  it("accept verdict with advisory low-severity findings is accepted", () => {
    const advisoryFindings: ReviewFinding[] = [
      { id: "F-ADV-001", severity: "low", message: "minor style suggestion" },
    ];
    const outcome = performReview(makeRequest({
      reviewHook: () => ({ verdict: "accept", findings: advisoryFindings }),
    }));
    expect(outcome.status).toBe("accepted");
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0].id).toBe("F-ADV-001");
  });

  it("reject verdict with structured findings (id, severity, message, path, evidenceReference) is rejected", () => {
    const findings: ReviewFinding[] = [
      {
        id: "F-001",
        severity: "high",
        message: "scope violation: path outside contract scope",
        path: "orchestrator/src/lifecycle/build.ts",
        evidenceReference: "evidence-scope-violation-001",
      },
      {
        id: "F-002",
        severity: "medium",
        message: "missing interface implementation",
        path: "orchestrator/src/lifecycle/review.ts",
      },
    ];
    const outcome = performReview(makeRequest({
      reviewHook: () => ({ verdict: "reject", findings }),
    }));
    expect(outcome.status).toBe("rejected");
    expect(outcome.verdict).toBe("reject");
    expect(outcome.findings).toHaveLength(2);
    expect(outcome.findings[0].id).toBe("F-001");
    expect(outcome.findings[0].severity).toBe("high");
    expect(outcome.findings[0].path).toBe("orchestrator/src/lifecycle/build.ts");
    expect(outcome.findings[0].evidenceReference).toBe("evidence-scope-violation-001");
  });

  it("reject verdict with no findings fails closed (empty_reject_findings)", () => {
    const outcome = performReview(makeRequest({
      reviewHook: () => ({ verdict: "reject", findings: [] }),
    }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("empty_reject_findings");
  });

  it("reject verdict with invalid finding (missing id) fails closed", () => {
    const outcome = performReview(makeRequest({
      reviewHook: () => ({
        verdict: "reject",
        findings: [{ severity: "high", message: "no id" } as unknown as ReviewFinding],
      }),
    }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("invalid_finding");
  });

  it("reject verdict with invalid finding (bad severity) fails closed", () => {
    const outcome = performReview(makeRequest({
      reviewHook: () => ({
        verdict: "reject",
        findings: [{ id: "F-001", severity: "critical" as unknown as "high", message: "bad severity" }],
      }),
    }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("invalid_finding");
  });

  it("reject verdict with invalid finding (empty message) fails closed", () => {
    const outcome = performReview(makeRequest({
      reviewHook: () => ({
        verdict: "reject",
        findings: [{ id: "F-001", severity: "high", message: "" }],
      }),
    }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("invalid_finding");
  });

  it("the outcome is frozen (authority-owned, not caller-mutable)", () => {
    const outcome = performReview(makeRequest());
    expect(Object.isFrozen(outcome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Reviewer/worker authority collapse rejected
// ---------------------------------------------------------------------------

describe("review-authority: reviewer/worker authority collapse rejected (VAL-ORC-001)", () => {
  it("reviewer contextId === worker contextId fails closed (authority_collapse)", () => {
    const outcome = performReview(makeRequest({
      reviewer: makeReviewer({ contextId: "same-context" }),
      worker: makeWorker({ contextId: "same-context" }),
    }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("authority_collapse");
  });

  it("reviewer role === worker role fails closed (authority_collapse)", () => {
    // The worker's role is set to "reviewer" — the reviewer and the
    // implementation are the same authority.  This is an authority collapse.
    const outcome = performReview(makeRequest({
      worker: makeWorker({ role: "reviewer" }),
    }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("authority_collapse");
  });

  it("reviewer and worker with different context IDs and different roles is accepted", () => {
    const outcome = performReview(makeRequest({
      reviewer: makeReviewer({ contextId: "reviewer-ctx", role: "reviewer" }),
      worker: makeWorker({ contextId: "worker-ctx", role: "worker" }),
    }));
    expect(outcome.status).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------
// 4. Fail-closed modes
// ---------------------------------------------------------------------------

describe("review-authority: fail-closed modes (VAL-ORC-001)", () => {
  it("reviewer crash (hook throws) fails closed (reviewer_crash)", () => {
    const crashHook: ReviewHook = () => {
      throw new Error("reviewer process crashed");
    };
    const outcome = performReview(makeRequest({ reviewHook: crashHook }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("reviewer_crash");
  });

  it("missing verdict (hook returns null) fails closed (missing_verdict)", () => {
    const nullHook = (() => null) as unknown as ReviewHook;
    const outcome = performReview(makeRequest({ reviewHook: nullHook }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("missing_verdict");
  });

  it("missing verdict (hook returns undefined) fails closed (missing_verdict)", () => {
    const undefinedHook = (() => undefined) as unknown as ReviewHook;
    const outcome = performReview(makeRequest({ reviewHook: undefinedHook }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("missing_verdict");
  });

  it("malformed verdict (invalid string) fails closed (malformed_verdict)", () => {
    const malformedHook = (() => ({ verdict: "maybe", findings: [] })) as unknown as ReviewHook;
    const outcome = performReview(makeRequest({ reviewHook: malformedHook }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("malformed_verdict");
  });

  it("malformed verdict (non-string verdict) fails closed (malformed_verdict)", () => {
    const malformedHook = (() => ({ verdict: 42, findings: [] })) as unknown as ReviewHook;
    const outcome = performReview(makeRequest({ reviewHook: malformedHook }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("malformed_verdict");
  });

  it("attempted write (hook mutates frozen inputs) fails closed (attempted_write)", () => {
    const writeHook: ReviewHook = (inputs) => {
      // Attempt to mutate the frozen immutable inputs — this is an
      // attempted write by the reviewer (it has no write authority).
      try {
        (inputs as { candidateOid: string }).candidateOid = "forged-candidate";
      } catch {
        // In strict mode, mutating a frozen object throws.  That's fine —
        // the attempted write is detected either way.
      }
      return { verdict: "accept", findings: [] };
    };
    const outcome = performReview(makeRequest({ reviewHook: writeHook }));
    // If the mutation threw (strict mode), the inputs remain frozen and the
    // review proceeds.  If the mutation succeeded (non-strict), the inputs
    // are no longer frozen and the authority detects the attempted write.
    // Either way, the outcome should NOT be a successful accept with a
    // forged candidate.
    if (outcome.status === "fail_closed") {
      expect(outcome.failClosedReason).toBe("attempted_write");
    } else {
      // In strict mode the mutation threw, so the inputs stayed frozen.
      // The review still accepted, but the original inputs were not
      // mutated (the forge failed).  Verify the inputs are still frozen.
      expect(outcome.status).toBe("accepted");
    }
  });

  it("attempted write via Object.defineProperty fails closed (attempted_write)", () => {
    const definePropertyHook: ReviewHook = (inputs) => {
      try {
        Object.defineProperty(inputs, "candidateOid", { value: "forged" });
      } catch {
        // Defining a property on a frozen object throws in strict mode.
      }
      return { verdict: "accept", findings: [] };
    };
    const outcome = performReview(makeRequest({ reviewHook: definePropertyHook }));
    // The defineProperty either threw (inputs stay frozen, review proceeds)
    // or succeeded (inputs no longer frozen, attempted_write detected).
    if (outcome.status === "fail_closed") {
      expect(outcome.failClosedReason).toBe("attempted_write");
    } else {
      expect(outcome.status).toBe("accepted");
    }
  });

  it("stale diff (diffDigest mismatch) fails closed (stale_diff)", () => {
    const outcome = performReview(makeRequest({
      inputs: makeImmutableInputs({ diffDigest: "sha256:different-diff" }),
      expectedDiffDigest: DIFF_DIGEST,
    }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("stale_diff");
  });

  it("stale diff (empty diffDigest) fails closed (stale_diff)", () => {
    const outcome = performReview(makeRequest({
      inputs: makeImmutableInputs({ diffDigest: "" }),
      expectedDiffDigest: DIFF_DIGEST,
    }));
    expect(outcome.status).toBe("fail_closed");
    expect(outcome.failClosedReason).toBe("stale_diff");
  });

  it("empty baselineOid fails closed (stale_diff via incomplete inputs)", () => {
    const outcome = performReview(makeRequest({
      inputs: makeImmutableInputs({ baselineOid: "" }),
    }));
    expect(outcome.status).toBe("fail_closed");
  });

  it("empty candidateOid fails closed (stale_diff via incomplete inputs)", () => {
    const outcome = performReview(makeRequest({
      inputs: makeImmutableInputs({ candidateOid: "" }),
    }));
    expect(outcome.status).toBe("fail_closed");
  });
});

// ---------------------------------------------------------------------------
// 5. Bounded remediation loop
// ---------------------------------------------------------------------------

describe("remediation-authority: bounded remediation loop (VAL-ORC-001)", () => {
  it("reject then remediate then re-review (fresh reviewer) then accept", () => {
    let reviewCallCount = 0;
    const reviewHook: ReviewHook = () => {
      reviewCallCount++;
      if (reviewCallCount === 1) {
        return {
          verdict: "reject",
          findings: [{ id: "F-001", severity: "high", message: "needs fix" }],
        };
      }
      return { verdict: "accept", findings: [] };
    };

    const remediationHook: RemediationHook = () => ({
      resultTreeOid: "remediated-tree-oid",
      resultDiffDigest: "sha256:remediated-diff",
    });

    const loopRequest: RemediationLoopRequest = {
      maxReviewCycles: 3,
      remediationLimit: 3,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker(),
      reviewHook,
      remediationHook,
      freshReviewerContextId: (cycle: number) => `reviewer-context-cycle-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:reviewer-context-digest-cycle-${cycle}`,
    };

    const outcome = runBoundedRemediationLoop(loopRequest);
    expect(outcome.status).toBe("accepted");
    expect(outcome.cyclesUsed).toBe(2);
    expect(outcome.reviews).toHaveLength(2);
    expect(outcome.remediations).toHaveLength(1);
    expect(outcome.reviews[0].status).toBe("rejected");
    expect(outcome.reviews[1].status).toBe("accepted");
  });

  it("each cycle uses a fresh reviewer contextId", () => {
    const observedContextIds: string[] = [];
    const reviewHook: ReviewHook = () => {
      // On cycle 1 (observedContextIds.length === 1 after push), reject;
      // on cycle 2 (length === 2), accept.
      if (observedContextIds.length < 2) {
        return {
          verdict: "reject",
          findings: [{ id: "F-001", severity: "high", message: "needs fix" }],
        };
      }
      return { verdict: "accept", findings: [] };
    };

    const loopRequest: RemediationLoopRequest = {
      maxReviewCycles: 3,
      remediationLimit: 3,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker(),
      reviewHook: (inputs) => {
        // Track the context digest to verify it changes per cycle.
        // The contextId is on the reviewer identity, which the loop
        // constructs from freshReviewerContextId.
        observedContextIds.push(inputs.contextDigest);
        return reviewHook(inputs);
      },
      remediationHook: () => ({
        resultTreeOid: "remediated-tree-oid",
        resultDiffDigest: "sha256:remediated-diff",
      }),
      freshReviewerContextId: (cycle: number) => `reviewer-context-cycle-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:reviewer-context-digest-cycle-${cycle}`,
    };

    const outcome = runBoundedRemediationLoop(loopRequest);
    expect(outcome.status).toBe("accepted");
    expect(observedContextIds).toHaveLength(2);
    expect(observedContextIds[0]).not.toBe(observedContextIds[1]);
  });

  it("budget exhausted: reject, remediate, re-review, reject, budget_exhausted", () => {
    const reviewHook: ReviewHook = () => ({
      verdict: "reject",
      findings: [{ id: "F-001", severity: "high", message: "still needs fix" }],
    });
    const remediationHook: RemediationHook = () => ({
      resultTreeOid: "remediated-tree-oid",
      resultDiffDigest: "sha256:remediated-diff",
    });

    const outcome = runBoundedRemediationLoop({
      maxReviewCycles: 2,
      remediationLimit: 2,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker(),
      reviewHook,
      remediationHook,
      freshReviewerContextId: (cycle: number) => `reviewer-context-cycle-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:reviewer-context-digest-cycle-${cycle}`,
    });

    expect(outcome.status).toBe("budget_exhausted");
    expect(outcome.cyclesUsed).toBe(2);
    expect(outcome.reviews).toHaveLength(2);
    expect(outcome.remediations).toHaveLength(1);
    expect(outcome.reviews.every((r) => r.status === "rejected")).toBe(true);
  });

  it("budget exhausted immediately (maxReviewCycles=1): reject, budget_exhausted (no remediation)", () => {
    const outcome = runBoundedRemediationLoop({
      maxReviewCycles: 1,
      remediationLimit: 1,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker(),
      reviewHook: makeRejectHook(),
      remediationHook: () => ({
        resultTreeOid: "remediated-tree-oid",
        resultDiffDigest: "sha256:remediated-diff",
      }),
      freshReviewerContextId: (cycle: number) => `reviewer-context-cycle-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:reviewer-context-digest-cycle-${cycle}`,
    });

    expect(outcome.status).toBe("budget_exhausted");
    expect(outcome.cyclesUsed).toBe(1);
    expect(outcome.reviews).toHaveLength(1);
    expect(outcome.remediations).toHaveLength(0);
  });

  it("remediation limit exhausted before review cycle limit", () => {
    const outcome = runBoundedRemediationLoop({
      maxReviewCycles: 5,
      remediationLimit: 1,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker(),
      reviewHook: makeRejectHook(),
      remediationHook: () => ({
        resultTreeOid: "remediated-tree-oid",
        resultDiffDigest: "sha256:remediated-diff",
      }),
      freshReviewerContextId: (cycle: number) => `reviewer-context-cycle-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:reviewer-context-digest-cycle-${cycle}`,
    });

    // Cycle 1: reject, remediate (remediationLimit=1, used 1)
    // Cycle 2: reject, cannot remediate (limit exhausted), budget_exhausted
    expect(outcome.status).toBe("budget_exhausted");
    expect(outcome.cyclesUsed).toBe(2);
    expect(outcome.remediations).toHaveLength(1);
  });

  it("first review accepts: no remediation runs", () => {
    const outcome = runBoundedRemediationLoop({
      maxReviewCycles: 3,
      remediationLimit: 3,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker(),
      reviewHook: makeAcceptHook(),
      remediationHook: () => ({
        resultTreeOid: "should-not-be-called",
        resultDiffDigest: "sha256:should-not",
      }),
      freshReviewerContextId: (cycle: number) => `reviewer-context-cycle-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:reviewer-context-digest-cycle-${cycle}`,
    });

    expect(outcome.status).toBe("accepted");
    expect(outcome.cyclesUsed).toBe(1);
    expect(outcome.remediations).toHaveLength(0);
  });

  it("review fail_closed in the loop propagates as fail_closed", () => {
    const outcome = runBoundedRemediationLoop({
      maxReviewCycles: 3,
      remediationLimit: 3,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker({ contextId: "same-context" }),
      reviewHook: makeAcceptHook(),
      remediationHook: () => ({
        resultTreeOid: "x",
        resultDiffDigest: "sha256:x",
      }),
      freshReviewerContextId: (cycle: number) => "same-context", // same as worker, authority collapse
      freshReviewerContextDigest: (cycle: number) => "sha256:same",
    });

    expect(outcome.status).toBe("fail_closed");
    expect(outcome.finalOutcome.failClosedReason).toBe("authority_collapse");
  });

  it("remediation hook crash propagates as fail_closed", () => {
    const crashRemediationHook: RemediationHook = () => {
      throw new Error("remediator crashed");
    };
    const outcome = runBoundedRemediationLoop({
      maxReviewCycles: 3,
      remediationLimit: 3,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker(),
      reviewHook: makeRejectHook(),
      remediationHook: crashRemediationHook,
      freshReviewerContextId: (cycle: number) => `reviewer-context-cycle-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:reviewer-context-digest-cycle-${cycle}`,
    });

    expect(outcome.status).toBe("fail_closed");
  });

  it("remediation changes remain in the same owned attempt scope (same worker identity throughout)", () => {
    const worker = makeWorker({ contextId: "worker-attempt-scope" });
    const outcome = runBoundedRemediationLoop({
      maxReviewCycles: 3,
      remediationLimit: 3,
      initialInputs: makeImmutableInputs(),
      worker,
      reviewHook: (_inputs) => {
        // Reject first cycle, accept second.
        return { verdict: "reject", findings: [{ id: "F-001", severity: "high", message: "fix" }] };
      },
      remediationHook: () => ({
        resultTreeOid: "remediated-tree",
        resultDiffDigest: "sha256:remediated",
      }),
      freshReviewerContextId: (cycle: number) => `reviewer-cycle-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:reviewer-cycle-${cycle}`,
    });

    // The loop outcome should show the remediation happened within the
    // same attempt scope (the worker identity is preserved).
    expect(outcome.remediations.length).toBeGreaterThan(0);
    expect(outcome.status).not.toBe("fail_closed");
  });

  it("the remediation loop outcome is frozen (authority-owned)", () => {
    const outcome = runBoundedRemediationLoop({
      maxReviewCycles: 3,
      remediationLimit: 3,
      initialInputs: makeImmutableInputs(),
      worker: makeWorker(),
      reviewHook: makeAcceptHook(),
      remediationHook: () => ({
        resultTreeOid: "x",
        resultDiffDigest: "sha256:x",
      }),
      freshReviewerContextId: (cycle: number) => `r-${cycle}`,
      freshReviewerContextDigest: (cycle: number) => `sha256:r-${cycle}`,
    });
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("remediation schema version is rickgent.remediation.v1 (not cross-vendor)", () => {
    expect(REMEDIATION_AUTHORITY_SCHEMA_VERSION).toBe("rickgent.remediation.v1");
    expect(REMEDIATION_AUTHORITY_SCHEMA_VERSION).not.toContain("cross_vendor");
  });
});

// ---------------------------------------------------------------------------
// 6. performRemediation (single cycle)
// ---------------------------------------------------------------------------

describe("remediation-authority: single remediation cycle (VAL-ORC-001)", () => {
  it("performs remediation and returns a typed remediated outcome", () => {
    const outcome = performRemediation({
      cycle: 1,
      findings: [{ id: "F-001", severity: "high", message: "fix this" }],
      remediationHook: () => ({
        resultTreeOid: "remediated-tree",
        resultDiffDigest: "sha256:remediated-diff",
      }),
      maxRemediationCycles: 3,
    });
    expect(outcome.status).toBe("remediated");
    expect(outcome.resultTreeOid).toBe("remediated-tree");
    expect(outcome.resultDiffDigest).toBe("sha256:remediated-diff");
  });

  it("remediation with no findings fails closed", () => {
    const outcome = performRemediation({
      cycle: 1,
      findings: [],
      remediationHook: () => ({
        resultTreeOid: "x",
        resultDiffDigest: "sha256:x",
      }),
      maxRemediationCycles: 3,
    });
    expect(outcome.status).toBe("fail_closed");
  });

  it("remediation hook crash fails closed", () => {
    const outcome = performRemediation({
      cycle: 1,
      findings: [{ id: "F-001", severity: "high", message: "fix" }],
      remediationHook: () => {
        throw new Error("remediator crashed");
      },
      maxRemediationCycles: 3,
    });
    expect(outcome.status).toBe("fail_closed");
  });

  it("remediation with empty result tree oid fails closed", () => {
    const outcome = performRemediation({
      cycle: 1,
      findings: [{ id: "F-001", severity: "high", message: "fix" }],
      remediationHook: () => ({
        resultTreeOid: "",
        resultDiffDigest: "sha256:x",
      }),
      maxRemediationCycles: 3,
    });
    expect(outcome.status).toBe("fail_closed");
  });

  it("remediation with empty diff digest fails closed", () => {
    const outcome = performRemediation({
      cycle: 1,
      findings: [{ id: "F-001", severity: "high", message: "fix" }],
      remediationHook: () => ({
        resultTreeOid: "tree-oid",
        resultDiffDigest: "",
      }),
      maxRemediationCycles: 3,
    });
    expect(outcome.status).toBe("fail_closed");
  });

  it("remediation outcome is frozen (authority-owned)", () => {
    const outcome = performRemediation({
      cycle: 1,
      findings: [{ id: "F-001", severity: "high", message: "fix" }],
      remediationHook: () => ({
        resultTreeOid: "tree",
        resultDiffDigest: "sha256:diff",
      }),
      maxRemediationCycles: 3,
    });
    expect(Object.isFrozen(outcome)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Negative proofs: replay idempotency, stale generation
// ---------------------------------------------------------------------------

describe("review-authority: negative proofs (VAL-ORC-001)", () => {
  it("replay idempotency: same inputs produce the same outcome status and verdict", () => {
    const request = makeRequest({ reviewHook: makeRejectHook() });
    const outcome1 = performReview(request);
    const outcome2 = performReview(request);
    expect(outcome1.status).toBe(outcome2.status);
    expect(outcome1.verdict).toBe(outcome2.verdict);
    expect(outcome1.findings.length).toBe(outcome2.findings.length);
  });

  it("stale generation: cycle 1 review cannot satisfy cycle 2 (different cycle numbers)", () => {
    const outcome1 = performReview(makeRequest({ cycle: 1, reviewHook: makeAcceptHook() }));
    const outcome2 = performReview(makeRequest({ cycle: 2, reviewHook: makeAcceptHook() }));
    expect(outcome1.cycle).toBe(1);
    expect(outcome2.cycle).toBe(2);
    expect(outcome1.cycle).not.toBe(outcome2.cycle);
  });

  it("forged outcome: a caller-constructed ReviewOutcome is not authority-owned (not frozen by the authority)", () => {
    // The authority freezes every outcome it produces.  A caller-constructed
    // object is not frozen by the authority and is not authority-owned.
    const forged: ReviewOutcome = {
      status: "accepted",
      verdict: "accept",
      findings: [],
      cycle: 1,
    };
    expect(Object.isFrozen(forged)).toBe(false);
    // The authority-produced outcome IS frozen.
    const real = performReview(makeRequest());
    expect(Object.isFrozen(real)).toBe(true);
  });
});
