import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/contracts/ticket-contract.js";
import {
  RICKGENT_ORACLE_VERSION,
  deriveOracleAttributionDigests,
  evaluateAttemptOracle,
  isOraclePersistencePlan,
  materializeOraclePersistenceRows,
  oraclePersistenceProjection,
  type AttemptOracleProjection,
  type OracleGateStatus,
  type OracleNormalizedDeltaEntry,
  type OracleReferenceKind,
  type OracleResolvedReferenceProjection,
} from "../../src/state/oracle.js";

const scope = Object.freeze({
  runId: "run-oracle",
  ticketInstanceId: "ticket-instance-oracle",
  attemptId: "attempt-oracle",
});

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function lineage(kind: OracleReferenceKind) {
  if (kind === "run_manifest") return { runId: scope.runId, ticketInstanceId: null, attemptId: null };
  if (kind === "ticket_contract" || kind === "dependency_edge") {
    return { runId: scope.runId, ticketInstanceId: scope.ticketInstanceId, attemptId: null };
  }
  return scope;
}

interface ReferenceOptions {
  readonly sealedContent?: Readonly<Record<string, unknown>>;
  readonly gate?: Readonly<{
    gateId: string;
    evaluationOrdinal: number;
    required: boolean;
    status: OracleGateStatus;
  }>;
  readonly referenceId?: string;
}

function reference(kind: OracleReferenceKind, options: ReferenceOptions = {}): OracleResolvedReferenceProjection {
  const contentDigest = options.sealedContent === undefined
    ? digest({ kind, identity: options.referenceId ?? `ref-${kind}` })
    : digest(options.sealedContent);
  const row: OracleResolvedReferenceProjection = {
    ordinal: -1,
    referenceKind: kind,
    referenceId: options.referenceId ?? (
      kind === "run_manifest" || kind === "ticket_contract" || kind === "dependency_edge"
        ? contentDigest
        : `ref-${kind}`
    ),
    ...lineage(kind),
    oracleVersion: RICKGENT_ORACLE_VERSION,
    contentDigest,
    resolvedContentDigest: contentDigest,
  };
  if (options.sealedContent !== undefined) (row as { sealedContent: Readonly<Record<string, unknown>> }).sealedContent = options.sealedContent;
  if (options.gate !== undefined) (row as { gate: ReferenceOptions["gate"] }).gate = options.gate;
  return row;
}

function ordered(references: readonly OracleResolvedReferenceProjection[]): readonly OracleResolvedReferenceProjection[] {
  return references.map((item, ordinal) => ({ ...item, ordinal }));
}

function resealed(
  reference: OracleResolvedReferenceProjection,
  sealedContent: Readonly<Record<string, unknown>>,
): OracleResolvedReferenceProjection {
  const contentDigest = digest(sealedContent);
  return { ...reference, sealedContent, contentDigest, resolvedContentDigest: contentDigest };
}

function projection(options: {
  readonly dependencies?: readonly string[];
  readonly reviewVerdicts?: readonly ("accepted" | "rejected")[];
  readonly gateStatus?: OracleGateStatus;
  readonly includeGate?: boolean;
  readonly includeRemediationEvidence?: boolean;
} = {}): AttemptOracleProjection {
  const dependencies = [...(options.dependencies ?? [])];
  const reviewVerdicts = [...(options.reviewVerdicts ?? ["accepted"] as const)];
  const candidateTreeOid = "a".repeat(40);
  const normalizedDelta: readonly OracleNormalizedDeltaEntry[] = [{
    path: "src/t15.ts",
    changeKind: "create",
    fromPath: null,
    beforeMode: null,
    afterMode: "100644",
  }];
  const attributionDigests = deriveOracleAttributionDigests(normalizedDelta);
  const contract = {
    id: "t15",
    depends_on: dependencies,
    scope: [{ path: "src/t15.ts", change_kind: "create", directory: false }],
    budgets: {
      max_review_cycles: Math.max(1, reviewVerdicts.length),
      remediation_limit: reviewVerdicts.filter((verdict) => verdict === "rejected").length,
    },
    verifications: [{ id: "gate-main" }],
  };
  const contractReference = reference("ticket_contract", { sealedContent: contract });
  const manifest = {
    oracle_version: RICKGENT_ORACLE_VERSION,
    tickets: [{
      ticket_id: "t15",
      contract_digest: contractReference.referenceId,
      depends_on_ticket_ids: dependencies,
    }],
  };
  const references: OracleResolvedReferenceProjection[] = [
    reference("run_manifest", { sealedContent: manifest }),
    contractReference,
    reference("execution_context"),
    reference("process_receipt"),
    reference("review_record", { sealedContent: {
      cycle: 1,
      verdict: reviewVerdicts[0],
      input_tree_oid: candidateTreeOid,
      input_diff_digest: attributionDigests.candidateDiffDigest,
    } }),
    reference("commit_attribution", { sealedContent: {
      contract_digest: contractReference.referenceId,
      baseline_oid: "b".repeat(40),
      parent_oid: "b".repeat(40),
      tree_before_oid: "c".repeat(40),
      tree_after_oid: candidateTreeOid,
      commit_oid: "d".repeat(40),
      candidate_diff_digest: attributionDigests.candidateDiffDigest,
      path_set_digest: attributionDigests.pathSetDigest,
      change_kind_set_digest: attributionDigests.changeKindSetDigest,
      mode_set_digest: attributionDigests.modeSetDigest,
      normalized_delta: normalizedDelta.map((entry) => ({
        path: entry.path,
        change_kind: entry.changeKind,
        from_path: entry.fromPath,
        before_mode: entry.beforeMode,
        after_mode: entry.afterMode,
      })),
    } }),
    reference("cleanup_record"),
    reference("attempt_resource_snapshot"),
    reference("lease_snapshot"),
  ];
  if (options.includeGate !== false) {
    const gate = {
      gateId: "gate-main",
      evaluationOrdinal: 0,
      required: true,
      status: options.gateStatus ?? "passed",
    } as const;
    references.splice(4, 0, reference("gate_result", {
      gate,
      sealedContent: {
        gate_id: gate.gateId,
        evaluation_ordinal: gate.evaluationOrdinal,
        required: 1,
        status: gate.status,
        candidate_tree_oid: candidateTreeOid,
        candidate_diff_digest: attributionDigests.candidateDiffDigest,
      },
    }));
  }
  for (let index = 1; index < reviewVerdicts.length; index += 1) {
    references.push(reference("review_record", {
      referenceId: `review-${index + 1}`,
      sealedContent: {
        cycle: index + 1,
        verdict: reviewVerdicts[index],
        input_tree_oid: candidateTreeOid,
        input_diff_digest: attributionDigests.candidateDiffDigest,
      },
    }));
  }
  for (const dependency of dependencies) {
    const edge = { run_id: scope.runId, ticket_id: "t15", depends_on_ticket_id: dependency };
    references.push(reference("dependency_edge", { sealedContent: edge }));
  }
  if (options.includeRemediationEvidence !== false) {
    for (let index = 0; index < reviewVerdicts.length; index += 1) {
      if (reviewVerdicts[index] === "rejected") {
        references.push(reference("evidence", {
          referenceId: `remediation-${index + 1}`,
          sealedContent: { oracle_input_class: "remediation_cycle", cycle: index + 1 },
        }));
      }
    }
  }
  return {
    oracleVersion: RICKGENT_ORACLE_VERSION,
    scope,
    references: ordered(references),
  };
}

const identity = Object.freeze({
  oracleDecisionId: "oracle-decision-1",
  idempotencyKey: "oracle-evaluation-1",
  createdAt: "2026-07-16T12:00:00.000Z",
});

describe("pure versioned oracle authority", () => {
  it("accepts a complete exact projection and materializes exact attempt-scoped rows", () => {
    const plan = evaluateAttemptOracle(projection());
    expect(plan).toMatchObject({
      oracleVersion: RICKGENT_ORACLE_VERSION,
      result: "accepted",
      reasons: [],
      referenceIntegrity: "exact",
    });
    expect(isOraclePersistencePlan(plan)).toBe(true);
    const rows = materializeOraclePersistenceRows(plan, identity);
    expect(rows.decision).toMatchObject({
      oracle_decision_id: identity.oracleDecisionId,
      oracle_version: RICKGENT_ORACLE_VERSION,
      scope_kind: "attempt",
      run_id: scope.runId,
      ticket_instance_id: scope.ticketInstanceId,
      attempt_id: scope.attemptId,
      input_set_digest: plan.inputSetDigest,
      result: "accepted",
      reasons_json: "[]",
      output_digest: plan.outputDigest,
    });
    expect(rows.references).toHaveLength(plan.references.length);
    expect(rows.references.map((row) => row.ordinal)).toEqual(plan.references.map((row) => row.ordinal));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.references)).toBe(true);
  });

  it("rejects forged object and prototype-cloned plans despite matching fields", () => {
    const issued = evaluateAttemptOracle(projection());
    const objectClone = { ...issued };
    const prototypeClone = Object.assign(Object.create(Object.getPrototypeOf(issued)), issued) as unknown;
    for (const forged of [objectClone, prototypeClone]) {
      expect(isOraclePersistencePlan(forged)).toBe(false);
      expect(() => oraclePersistenceProjection(forged)).toThrow(/not issued/i);
      expect(() => materializeOraclePersistenceRows(forged, identity)).toThrow(/not issued/i);
    }
  });

  it.each(["failed", "missing", "null"] as const)("rejects a required gate with %s status", (status) => {
    const plan = evaluateAttemptOracle(projection({ gateStatus: status }));
    expect(plan.result).toBe("rejected");
    expect(plan.reasons).toContain(`required_gate_blocking:ref-gate_result:${status}`);
    expect(plan.referenceIntegrity).toBe("exact");
    expect(materializeOraclePersistenceRows(plan, identity).decision.result).toBe("rejected");
  });

  it("rejects a projection with no gate class", () => {
    const plan = evaluateAttemptOracle(projection({ includeGate: false }));
    expect(plan.result).toBe("rejected");
    expect(plan.reasons).toEqual(expect.arrayContaining([
      "missing_input_class:required_gates",
      "required_gate_missing",
    ]));
  });

  it("derives dependency and remediation cardinalities from sealed content", () => {
    const dependencyPlan = evaluateAttemptOracle(projection({ dependencies: ["t14"] }));
    expect(dependencyPlan.result).toBe("accepted");
    const withoutDependency = projection({ dependencies: ["t14"] });
    const dependencyMissing = evaluateAttemptOracle({
      ...withoutDependency,
      references: ordered(withoutDependency.references.filter((item) => item.referenceKind !== "dependency_edge")),
    });
    expect(dependencyMissing.reasons).toContain("dependency_edge_missing_or_duplicate:t14");

    const remediationPlan = evaluateAttemptOracle(projection({ reviewVerdicts: ["rejected", "accepted"] }));
    expect(remediationPlan.result).toBe("accepted");
    const remediationMissing = evaluateAttemptOracle(projection({
      reviewVerdicts: ["rejected", "accepted"],
      includeRemediationEvidence: false,
    }));
    expect(remediationMissing.reasons).toContain("remediation_cycle_missing_or_duplicate:1");
  });

  it("rejects ordinal and digest mutation, while binding a valid reordered set to new digests", () => {
    const baseline = projection();
    const accepted = evaluateAttemptOracle(baseline);
    const reversed = evaluateAttemptOracle({ ...baseline, references: [...baseline.references].reverse() });
    expect(reversed.result).toBe("rejected");
    expect(reversed.reasons.some((reason) => reason.startsWith("reference_ordinal_mismatch:"))).toBe(true);

    const changed = baseline.references.map((item, index) => index === 2
      ? { ...item, contentDigest: digest({ tampered: true }) }
      : item);
    const digestMismatch = evaluateAttemptOracle({ ...baseline, references: changed });
    expect(digestMismatch.result).toBe("rejected");
    expect(digestMismatch.referenceIntegrity).toBe("invalid");
    expect(digestMismatch.reasons.some((reason) => reason.startsWith("reference_content_digest_mismatch:"))).toBe(true);
    expect(() => materializeOraclePersistenceRows(digestMismatch, identity)).toThrow(/invalid reference integrity/i);

    const reordered = evaluateAttemptOracle({ ...baseline, references: ordered([...baseline.references].reverse()) });
    expect(reordered.result).toBe("accepted");
    expect(reordered.inputSetDigest).not.toBe(accepted.inputSetDigest);
    expect(reordered.outputDigest).not.toBe(accepted.outputDigest);
  });

  it("is deterministic for exact replay and materialization", () => {
    const input = projection({ dependencies: ["t14"], reviewVerdicts: ["rejected", "accepted"] });
    const first = evaluateAttemptOracle(input);
    const second = evaluateAttemptOracle(structuredClone(input));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(materializeOraclePersistenceRows(first, identity)).toEqual(materializeOraclePersistenceRows(second, identity));
  });

  it("rejects exact-lineage, oracle-version, and sealed-content mutation", () => {
    const input = projection();
    const lineageMutation = input.references.map((item, index) => index === 2 ? { ...item, attemptId: "other-attempt" } : item);
    expect(evaluateAttemptOracle({ ...input, references: lineageMutation }).reasons)
      .toEqual(expect.arrayContaining([expect.stringMatching(/^reference_lineage_mismatch:/)]));

    const versionMutation = input.references.map((item, index) => index === 2 ? { ...item, oracleVersion: "future-oracle" } : item);
    expect(evaluateAttemptOracle({ ...input, references: versionMutation }).reasons)
      .toEqual(expect.arrayContaining([expect.stringMatching(/^reference_oracle_version_mismatch:/)]));

    const contentMutation = input.references.map((item) => item.referenceKind === "ticket_contract"
      ? { ...item, sealedContent: { ...item.sealedContent, depends_on: ["forged"] } }
      : item);
    expect(evaluateAttemptOracle({ ...input, references: contentMutation }).reasons)
      .toEqual(expect.arrayContaining([expect.stringMatching(/^reference_sealed_content_digest_mismatch:/)]));
  });

  it("binds the final accepted review and every required gate to the attributed candidate", () => {
    const baseline = projection();
    const changedTree = "e".repeat(40);
    const reviewMutation = baseline.references.map((item) => item.referenceKind === "review_record"
      ? resealed(item, { ...item.sealedContent, input_tree_oid: changedTree })
      : item);
    expect(evaluateAttemptOracle({ ...baseline, references: reviewMutation }).reasons)
      .toContain(`final_review_candidate_mismatch:ref-review_record`);

    const gateMutation = baseline.references.map((item) => item.referenceKind === "gate_result"
      ? resealed(item, { ...item.sealedContent, candidate_tree_oid: changedTree })
      : item);
    expect(evaluateAttemptOracle({ ...baseline, references: gateMutation }).reasons)
      .toContain(`required_gate_candidate_mismatch:gate-main:ref-gate_result`);
  });

  it("derives attribution digests from normalized delta and proves the delta against sealed scope", () => {
    const baseline = projection();
    const attribution = baseline.references.find((item) => item.referenceKind === "commit_attribution")!;
    const digestMutation = baseline.references.map((item) => item === attribution
      ? resealed(item, { ...item.sealedContent, path_set_digest: digest(["forged"]) })
      : item);
    expect(evaluateAttemptOracle({ ...baseline, references: digestMutation }).reasons)
      .toContain(`commit_attribution_digest_mismatch:${attribution.referenceId}`);

    const outOfScopeDelta: readonly OracleNormalizedDeltaEntry[] = [{
      path: "src/foreign.ts",
      changeKind: "create",
      fromPath: null,
      beforeMode: null,
      afterMode: "100644",
    }];
    const derived = deriveOracleAttributionDigests(outOfScopeDelta);
    const scopeMutation = baseline.references.map((item) => item === attribution
      ? resealed(item, {
        ...item.sealedContent,
        candidate_diff_digest: derived.candidateDiffDigest,
        path_set_digest: derived.pathSetDigest,
        change_kind_set_digest: derived.changeKindSetDigest,
        mode_set_digest: derived.modeSetDigest,
        normalized_delta: [{
          path: "src/foreign.ts",
          change_kind: "create",
          from_path: null,
          before_mode: null,
          after_mode: "100644",
        }],
      })
      : item);
    expect(evaluateAttemptOracle({ ...baseline, references: scopeMutation }).reasons)
      .toContain(`commit_attribution_scope_mismatch:${attribution.referenceId}`);
  });
});
