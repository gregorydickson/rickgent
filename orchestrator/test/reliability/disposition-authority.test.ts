import { describe, expect, it } from "vitest";
import {
  CleanupEligibilityReceipt,
  FailureCleanupReceipt,
  LeaseAuthorityMintCapability,
  PromotionCleanupReceipt,
  QuarantineReceipt,
  TargetNeverReleasedReceipt,
  assertCleanupEligibilityObservation,
  assertQuarantineObservation,
  assertTargetNeverReleasedObservation,
  createLeaseAuthorityMintCapability,
  isCleanupEligibilityReceipt,
  isFailureCleanupReceipt,
  isLeaseAuthorityMintCapability,
  isPromotionCleanupReceipt,
  isQuarantineReceipt,
  isTargetNeverReleasedReceipt,
  mintCleanupEligibilityReceipt,
  mintFailureCleanupReceipt,
  mintPromotionCleanupReceipt,
  mintQuarantineReceipt,
  mintTargetNeverReleasedReceipt,
  type AttemptResourceSlot,
  type CleanupEligibilityObservation,
  type FailureCleanupObservation,
  type PromotionCleanupObservation,
  type QuarantineInventoryEntry,
  type QuarantineObservation,
  type ResourceClaimPreimage,
  type TargetNeverReleasedObservation,
} from "../../src/lifecycle/disposition.js";

const digest = `sha256:${"a".repeat(64)}` as const;
const oid = "b".repeat(40);
const observedAt = "2026-07-18T12:00:00.000Z";
const common = {
  receiptId: "receipt-1",
  attemptId: "attempt-1",
  ownershipId: "ownership-1",
  ownerGeneration: 1,
  ownershipContextDigest: digest,
  contextId: "context-1",
  observedAt,
} as const;
const cleanupCommon = { ...common, ownershipStateVersion: 4 } as const;
const claimSlots = [
  "delivery_ref",
  "attempt_ref",
  "worktree",
  "isolated_index",
  "policy_context",
  "policy_bundle",
  "process_group",
  "stdout",
  "stderr",
  "verification_output",
  "salvage_archive",
] as const satisfies readonly AttemptResourceSlot[];
const claims: readonly ResourceClaimPreimage[] = claimSlots.map((slot, index) => ({
  resourceClaimId: `claim-${slot}`,
  slot,
  expectedState: "cleanup_pending",
  expectedVersion: index + 1,
}));
const targetProofs = [{
  phaseExecutionId: "phase-1",
  contextId: "context-1",
  targetStartGateId: "gate-1",
  gateEvidenceId: "gate-evidence-1",
  gateEvidenceDigest: digest,
  launchId: "launch-1",
  processReceiptId: "process-receipt-1",
  groupDeathEvidenceId: "death-1",
  groupDeathEvidenceDigest: digest,
  proofKind: "terminal_process" as const,
  memberDigest: digest,
}];

const neverReleased: TargetNeverReleasedObservation = {
  ...common,
  kind: "target_never_released_observation",
  phaseExecutionId: "phase-1",
  launchId: null,
  gateId: "gate-1",
  gateVersion: 1,
  containmentId: null,
  containmentDisposition: "not_created",
  containmentEvidenceDigest: null,
  reason: "containment_unavailable",
};

const killedBootstrap: TargetNeverReleasedObservation = {
  ...neverReleased,
  launchId: "launch-1",
  containmentId: "launch-1",
  containmentDisposition: "authoritatively_empty",
  containmentEvidenceDigest: digest,
  reason: "policy_unavailable",
};

const eligibility: CleanupEligibilityObservation = {
  ...cleanupCommon,
  kind: "cleanup_eligibility_observation",
  commitIntentId: "commit-intent-1",
  commitAttributionId: "attribution-1",
  candidateOid: oid,
  attemptRefObservedOid: oid,
  deliveryRef: "refs/rickgent/runs/run-1/delivery",
  deliveryBaselineOid: oid,
  deliveryObservedOid: oid,
  attemptRef: "refs/rickgent/runs/run-1/attempts/attempt-1",
  claims,
  targetProofs,
};

const failure: FailureCleanupObservation = {
  ...cleanupCommon,
  kind: "failure_cleanup_observation",
  cleanupIntentId: "failure-intent-1",
  failureCode: "verification_failed",
  deliveryRef: "refs/rickgent/runs/run-1/delivery",
  deliveryBaselineOid: oid,
  deliveryObservedOid: oid,
  attemptRef: "refs/rickgent/runs/run-1/attempts/attempt-1",
  expectedAttemptRefOid: oid,
  salvageRecordId: "salvage-1",
  targetProofs,
  claims,
  absentResourceSlots: claimSlots,
  callerBeforeDigest: digest,
  callerAfterDigest: digest,
};

const promotion: PromotionCleanupObservation = {
  ...cleanupCommon,
  kind: "promotion_cleanup_observation",
  cleanupIntentId: "promotion-cleanup-intent-1",
  cleanupEligibilityReceiptId: "eligibility-1",
  oracleDecisionId: "oracle-1",
  promotionIntentId: "promotion-1",
  promotionObservationEvidenceId: "promotion-observation-1",
  commitAttributionId: "attribution-1",
  deliveryRef: "refs/rickgent/runs/run-1/delivery",
  expectedOldOid: "c".repeat(40),
  candidateOid: oid,
  deliveryObservedOid: oid,
  claims,
  absentResourceSlots: claimSlots,
  callerBeforeDigest: digest,
  callerAfterDigest: digest,
};

const inventory: readonly QuarantineInventoryEntry[] = claims.map((claim) => ({
  resourceClaimId: claim.resourceClaimId,
  slot: claim.slot,
  logicalDisposition: "quarantined",
  physicalDisposition: claim.slot === "delivery_ref" ? "not_applicable" : "retained",
  canonicalIdentity: `identity-${claim.slot}`,
  observedPath: claim.slot === "delivery_ref" ? null : `/private/attempt/${claim.slot}`,
  observedKind: claim.slot === "delivery_ref"
    ? null
    : claim.slot === "attempt_ref"
      ? "git_ref"
      : claim.slot === "process_group"
        ? "process_boundary"
        : "directory",
  contentDigest: null,
}));

const quarantine: QuarantineObservation = {
  ...cleanupCommon,
  kind: "quarantine_observation",
  quarantineIntentId: "quarantine-intent-1",
  reasonCode: "resource_identity_ambiguous",
  deliveryRef: "refs/rickgent/runs/run-1/delivery",
  deliveryObservedOid: oid,
  targetProofs,
  claims,
  inventory,
  callerBeforeDigest: digest,
  callerAfterDigest: digest,
};

const predicates = [
  isTargetNeverReleasedReceipt,
  isCleanupEligibilityReceipt,
  isFailureCleanupReceipt,
  isPromotionCleanupReceipt,
  isQuarantineReceipt,
] as const;

describe("attempt disposition runtime authority", () => {
  it("requires the complete fixed 11-claim cleanup preimage", () => {
    expect(() => assertCleanupEligibilityObservation({
      ...eligibility,
      claims: claims.slice(0, -1),
    })).toThrow(/exact 11 resource slots/i);

    expect(() => assertCleanupEligibilityObservation({
      ...eligibility,
      claims: [...claims.slice(0, -1), { ...claims[0], resourceClaimId: "claim-duplicate-slot" }],
    })).toThrow(/unique ids and slots/i);
  });

  it("requires exact cleanup ownership and observed ref semantics", () => {
    expect(() => assertCleanupEligibilityObservation({
      ...eligibility,
      ownershipStateVersion: -1,
    })).toThrow(/ownershipStateVersion.*nonnegative/i);

    expect(() => assertCleanupEligibilityObservation({
      ...eligibility,
      attemptRefObservedOid: "c".repeat(40),
    })).toThrow(/exact candidate/i);

    expect(() => assertCleanupEligibilityObservation({
      ...eligibility,
      deliveryObservedOid: "c".repeat(40),
    })).toThrow(/delivery baseline unchanged/i);

    expect(() => assertCleanupEligibilityObservation({
      ...eligibility,
      targetProofs: [{ ...targetProofs[0], launchId: null }],
    })).toThrow(/only target-never-released proof may omit launchId/i);
  });

  it("accepts a no-launch target closure only at gate version one", () => {
    expect(() => assertTargetNeverReleasedObservation(neverReleased)).not.toThrow();
    expect(() => assertTargetNeverReleasedObservation({
      ...neverReleased,
      gateVersion: 0,
    })).toThrow(/gateVersion must be 1/i);
  });

  it("represents a killed bootstrap under a never-released target gate", () => {
    expect(() => assertTargetNeverReleasedObservation(killedBootstrap)).not.toThrow();
    expect(() => assertCleanupEligibilityObservation({
      ...eligibility,
      targetProofs: [{ ...targetProofs[0], proofKind: "never_released" }],
    })).not.toThrow();
    expect(() => assertTargetNeverReleasedObservation({
      ...neverReleased,
      launchId: "launch-1",
    })).toThrow(/launch identity must exist exactly/i);
    expect(() => assertTargetNeverReleasedObservation({
      ...killedBootstrap,
      launchId: null,
    })).toThrow(/launch identity must exist exactly/i);
    expect(() => assertTargetNeverReleasedObservation({
      ...killedBootstrap,
      containmentId: "another-containment",
    })).toThrow(/containment identity must equal/i);
    expect(() => assertTargetNeverReleasedObservation({
      ...killedBootstrap,
      containmentDisposition: "forged" as TargetNeverReleasedObservation["containmentDisposition"],
    })).toThrow(/containment disposition is invalid/i);
  });

  it("represents unknown quarantine inventory without claiming absence", () => {
    expect(() => assertQuarantineObservation({
      ...quarantine,
      inventory: inventory.map((entry) => entry.slot === "worktree"
        ? { ...entry, physicalDisposition: "unknown" as const }
        : entry),
    })).not.toThrow();
  });

  it.each([
    [TargetNeverReleasedReceipt, neverReleased],
    [CleanupEligibilityReceipt, eligibility],
    [FailureCleanupReceipt, failure],
    [PromotionCleanupReceipt, promotion],
    [QuarantineReceipt, quarantine],
  ] as const)("does not let callers construct %s", (Receipt, input) => {
    // The Receipt constructor's input parameter is the specific observation
    // type for that receipt; the it.each payload is the union of all five.
    // Cast through the receipt's own constructor input type so no `as never`
    // escape hatch is needed.
    type ConstructorInput<I> = I extends new (authority: symbol, input: infer T) => unknown ? T : never;
    const forgedInput = input as unknown as ConstructorInput<typeof Receipt>;
    expect(() => new Receipt(Symbol("caller"), forgedInput)).toThrow(/require/i);
    expect(() => new Receipt(Symbol.for("rickgent.disposition"), forgedInput)).toThrow(/require/i);
  });

  it("rejects structural and prototype forgeries across all five proof types", () => {
    const inputs = [neverReleased, eligibility, failure, promotion, quarantine];
    const prototypes = [
      TargetNeverReleasedReceipt.prototype,
      CleanupEligibilityReceipt.prototype,
      FailureCleanupReceipt.prototype,
      PromotionCleanupReceipt.prototype,
      QuarantineReceipt.prototype,
    ];

    for (const input of inputs) {
      for (const predicate of predicates) expect(predicate({ ...input })).toBe(false);
    }
    for (const prototype of prototypes) {
      const forged = Object.assign(Object.create(prototype) as object, neverReleased);
      for (const predicate of predicates) expect(predicate(forged)).toBe(false);
    }
  });

  it("keeps all raw inputs and forged prototypes non-interchangeable", () => {
    const forgedEligibility = Object.assign(Object.create(CleanupEligibilityReceipt.prototype) as object, eligibility);
    expect(isCleanupEligibilityReceipt(forgedEligibility)).toBe(false);
    expect(isFailureCleanupReceipt(forgedEligibility)).toBe(false);
    expect(isPromotionCleanupReceipt(forgedEligibility)).toBe(false);
    expect(isQuarantineReceipt(forgedEligibility)).toBe(false);
    expect(isTargetNeverReleasedReceipt(forgedEligibility)).toBe(false);
  });

  it("rejects serialized receipt lookalikes", () => {
    for (const input of [neverReleased, eligibility, failure, promotion, quarantine]) {
      const serialized = JSON.parse(JSON.stringify(input)) as unknown;
      for (const predicate of predicates) expect(predicate(serialized)).toBe(false);
    }
  });

  it("rejects every cross-type prototype forgery across all five receipt classes", () => {
    const realInputs: readonly Readonly<Record<string, unknown>>[] = [
      neverReleased, eligibility, failure, promotion, quarantine,
    ];
    const prototypes = [
      TargetNeverReleasedReceipt.prototype,
      CleanupEligibilityReceipt.prototype,
      FailureCleanupReceipt.prototype,
      PromotionCleanupReceipt.prototype,
      QuarantineReceipt.prototype,
    ] as const;
    // A receipt minted under one authority must not satisfy any other
    // receipt's predicate, even when its prototype is reassigned to a
    // different receipt class.  This closes the cross-type forgery vector.
    for (const input of realInputs) {
      for (const foreignPrototype of prototypes) {
        const forged = Object.assign(Object.create(foreignPrototype) as object, input);
        for (const predicate of predicates) expect(predicate(forged)).toBe(false);
      }
    }
  });

  it("rejects a forged LeaseAuthorityMintCapability constructed with a foreign symbol", () => {
    expect(() => new LeaseAuthorityMintCapability(Symbol("rickgent.disposition-mint-authority"))).toThrow(/LeaseAuthority/);
    expect(() => new LeaseAuthorityMintCapability(Symbol.for("rickgent.disposition-mint-authority"))).toThrow(/LeaseAuthority/);
    expect(isLeaseAuthorityMintCapability({})).toBe(false);
    expect(isLeaseAuthorityMintCapability(null)).toBe(false);
    expect(isLeaseAuthorityMintCapability(Object.create(LeaseAuthorityMintCapability.prototype))).toBe(false);
  });

  it("mints each receipt type only via the LeaseAuthority capability and rejects a forged capability", () => {
    const minters = [
      (capability: unknown) => mintTargetNeverReleasedReceipt(neverReleased, capability as never),
      (capability: unknown) => mintCleanupEligibilityReceipt(eligibility, capability as never),
      (capability: unknown) => mintFailureCleanupReceipt(failure, capability as never),
      (capability: unknown) => mintPromotionCleanupReceipt(promotion, capability as never),
      (capability: unknown) => mintQuarantineReceipt(quarantine, capability as never),
    ] as const;
    const predicatesByIndex = [
      isTargetNeverReleasedReceipt,
      isCleanupEligibilityReceipt,
      isFailureCleanupReceipt,
      isPromotionCleanupReceipt,
      isQuarantineReceipt,
    ] as const;

    // A forged capability (not issued by LeaseAuthority) cannot mint any receipt.
    for (const mint of minters) {
      expect(() => mint({})).toThrow(/LeaseAuthority/);
      expect(() => mint(null)).toThrow(/LeaseAuthority/);
      expect(() => mint(Object.create(LeaseAuthorityMintCapability.prototype))).toThrow(/LeaseAuthority/);
      expect(() => mint(new LeaseAuthorityMintCapability(Symbol("forged")))).toThrow(/LeaseAuthority/);
    }

    // The real factory-issued capability mints exactly one branded receipt of
    // its own type; the receipt does not satisfy any other receipt's predicate.
    const capability = createLeaseAuthorityMintCapability();
    expect(isLeaseAuthorityMintCapability(capability)).toBe(true);
    const minted = [
      mintTargetNeverReleasedReceipt(neverReleased, capability),
      mintCleanupEligibilityReceipt(eligibility, capability),
      mintFailureCleanupReceipt(failure, capability),
      mintPromotionCleanupReceipt(promotion, capability),
      mintQuarantineReceipt(quarantine, capability),
    ] as const;
    for (let index = 0; index < minted.length; index += 1) {
      for (let predicate = 0; predicate < predicatesByIndex.length; predicate += 1) {
        expect(predicatesByIndex[predicate]!(minted[index]!)).toBe(predicate === index);
      }
    }
  });
});
