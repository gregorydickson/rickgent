import type { StateRecord, StateStore } from "./store.js";

export type TransitionEntityKind = "run" | "ticket" | "attempt";

export interface ExistingTransitionEvidenceReference {
  readonly purpose: string;
  readonly evidenceId: string;
}

export interface InlineTransitionEvidence {
  readonly contextId: string;
  readonly producerService: string;
  readonly scope: string;
  readonly schemaVersion: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface InlineTransitionEvidenceReference {
  readonly purpose: string;
  readonly inlineEvidence: InlineTransitionEvidence;
}

export type TransitionEvidenceReference = ExistingTransitionEvidenceReference | InlineTransitionEvidenceReference;
export type PersistedTransitionEvidenceReference = ExistingTransitionEvidenceReference;

interface TransitionRequest {
  readonly expectedVersion: number;
  readonly ownerContextDigest: string;
  readonly idempotencyKey: string;
  readonly evidence: readonly TransitionEvidenceReference[];
}

export interface RunTransitionRequest extends TransitionRequest {
  readonly runId: string;
}

export interface TicketTransitionRequest extends TransitionRequest {
  readonly ticketInstanceId: string;
}

export interface AttemptTransitionRequest extends TransitionRequest {
  readonly attemptId: string;
}

export interface RunActivationRequest extends RunTransitionRequest {
  readonly initialAttemptId: string;
}

export interface TicketActivationRequest extends TicketTransitionRequest {
  readonly attemptId: string;
}

export interface LeaseGuardedAttemptRequest extends AttemptTransitionRequest {
  readonly ownershipId: string;
}

export interface ProcessReceiptGuardedAttemptRequest extends AttemptTransitionRequest {
  readonly processReceiptId: string;
}

export interface ContextGuardedAttemptRequest extends AttemptTransitionRequest {
  readonly contextId: string;
}

export interface ReviewGuardedAttemptRequest extends AttemptTransitionRequest {
  readonly reviewRecordId: string;
}

export interface RemediationGuardedAttemptRequest extends AttemptTransitionRequest {
  readonly remediationRecordId: string;
}

export interface GateGuardedAttemptRequest extends AttemptTransitionRequest {
  readonly gateResultIds: readonly string[];
}

export interface CleanupPendingAttemptRequest extends AttemptTransitionRequest {
  readonly commitAttributionId?: string;
}

export interface CleanupGuardedAttemptRequest extends AttemptTransitionRequest {
  readonly cleanupRecordId: string;
}

export interface OracleEvaluationRequest extends AttemptTransitionRequest {
  readonly oracleDecisionId: string;
  readonly promotionIntentId: string;
}

export interface VerifiedAttemptRequest extends OracleEvaluationRequest {
  readonly cleanupRecordId: string;
}

export interface TicketCleanupRequest extends TicketTransitionRequest {
  readonly attemptId: string;
}

export interface TicketFailureRequest extends TicketCleanupRequest {
  readonly cleanupRecordId: string;
}

export interface ReadyTicketRequest extends TicketFailureRequest {
  readonly oracleDecisionId: string;
  readonly promotionIntentId: string;
}

export interface RunFailureRequest extends RunTransitionRequest {
  readonly cleanupRecordId: string;
}

export interface BeginRunCleanupRequest extends RunTransitionRequest {
  readonly attemptId: string;
}

export interface ReactivateRunRequest extends RunTransitionRequest {
  readonly cleanupRecordId: string;
}

export interface TransitionResult {
  readonly transitionId: string;
  readonly entityKind: TransitionEntityKind;
  readonly entityId: string;
  readonly entitySequence: number;
  readonly fromState: string;
  readonly toState: string;
  readonly ownerService: string;
  readonly inputDigest: string;
  readonly stateVersion: number;
  readonly evidence: readonly PersistedTransitionEvidenceReference[];
  readonly state: StateRecord;
}

export type TransitionGuard =
  | { readonly kind: "run_initial_attempt"; readonly attemptId: string }
  | { readonly kind: "ticket_attempt_allocation"; readonly attemptId: string; readonly retry: boolean }
  | { readonly kind: "live_lease"; readonly ownershipId: string }
  | { readonly kind: "process_receipt"; readonly processReceiptId: string }
  | { readonly kind: "execution_context"; readonly contextId: string }
  | { readonly kind: "review_record"; readonly reviewRecordId: string; readonly verdict: "accepted" | "rejected" }
  | { readonly kind: "remediation_record"; readonly remediationRecordId: string }
  | { readonly kind: "gate_results"; readonly gateResultIds: readonly string[] }
  | { readonly kind: "cleanup_pending"; readonly commitAttributionId?: string }
  | { readonly kind: "cleanup_record"; readonly cleanupRecordId: string; readonly outcome: "failed_clean" | "quarantined" }
  | { readonly kind: "oracle_promotion"; readonly oracleDecisionId: string; readonly promotionIntentId: string }
  | { readonly kind: "verified_promotion"; readonly oracleDecisionId: string; readonly promotionIntentId: string; readonly cleanupRecordId: string }
  | { readonly kind: "ticket_attempt_cleanup"; readonly attemptId: string }
  | { readonly kind: "ticket_failure"; readonly attemptId: string; readonly cleanupRecordId: string; readonly quarantined: boolean }
  | { readonly kind: "ticket_finalization"; readonly attemptId: string; readonly cleanupRecordId: string; readonly oracleDecisionId: string; readonly promotionIntentId: string }
  | { readonly kind: "run_cleanup_begin"; readonly attemptId: string }
  | { readonly kind: "run_cleanup_complete"; readonly cleanupRecordId: string }
  | { readonly kind: "run_failure"; readonly cleanupRecordId: string }
  | { readonly kind: "run_ready" }
  | { readonly kind: "delivery_record"; readonly deliveryRecordId: string; readonly decision: "delivered" | "delivery_failed" };

const TRANSITION_COMMIT_AUTHORITY = Symbol("rickgent.transition-authority");
const AUTHORIZED_TRANSITION_COMMITS = new WeakSet<object>();

export class TransitionCommit {
  constructor(
    authority: symbol,
    readonly entityKind: TransitionEntityKind,
    readonly entityId: string,
    readonly fromState: string,
    readonly toState: string,
    readonly ownerService: string,
    readonly expectedVersion: number,
    readonly ownerContextDigest: string,
    readonly idempotencyKey: string,
    readonly evidence: readonly TransitionEvidenceReference[],
    readonly guard: TransitionGuard,
  ) {
    if (authority !== TRANSITION_COMMIT_AUTHORITY) throw new TypeError("transition commits can only be minted by TransitionAuthority");
    Object.freeze(this.evidence);
    Object.freeze(this.guard);
    Object.freeze(this);
    AUTHORIZED_TRANSITION_COMMITS.add(this);
  }

}

export function isAuthorizedTransitionCommit(value: unknown): value is TransitionCommit {
  return typeof value === "object" && value !== null && AUTHORIZED_TRANSITION_COMMITS.has(value);
}

function authorizedCommit(
  entityKind: TransitionEntityKind,
  entityId: string,
  fromState: string,
  toState: string,
  ownerService: string,
  request: TransitionRequest,
  guard: TransitionGuard,
): TransitionCommit {
  return new TransitionCommit(
    TRANSITION_COMMIT_AUTHORITY,
    entityKind,
    entityId,
    fromState,
    toState,
    ownerService,
    request.expectedVersion,
    request.ownerContextDigest,
    request.idempotencyKey,
    Object.freeze(request.evidence.map((reference) => Object.freeze({ ...reference }))),
    guard,
  );
}

/** Service-owned lifecycle edges. This class intentionally exposes no generic transition method. */
export class TransitionAuthority {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  #commit(
    kind: TransitionEntityKind,
    id: string,
    from: string,
    to: string,
    owner: string,
    request: TransitionRequest,
    guard: TransitionGuard,
  ): TransitionResult {
    return this.#store.commitAuthorizedTransition(authorizedCommit(kind, id, from, to, owner, request, guard));
  }

  activateRun(request: RunActivationRequest): TransitionResult {
    return this.#commit("run", request.runId, "planned", "active", "RunAllocationService", request, { kind: "run_initial_attempt", attemptId: request.initialAttemptId });
  }

  activateInitialTicket(request: TicketActivationRequest): TransitionResult {
    return this.#commit("ticket", request.ticketInstanceId, "planned", "active", "RunAllocationService", request, { kind: "ticket_attempt_allocation", attemptId: request.attemptId, retry: false });
  }

  activateRetryTicket(request: TicketActivationRequest): TransitionResult {
    return this.#commit("ticket", request.ticketInstanceId, "cleanup_pending", "active", "RetryAllocationService", request, { kind: "ticket_attempt_allocation", attemptId: request.attemptId, retry: true });
  }

  startAttempt(request: LeaseGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "planned", "implementing", "AttemptLifecycleService", request, { kind: "live_lease", ownershipId: request.ownershipId });
  }

  captureImplementation(request: ProcessReceiptGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "implementing", "implementation_captured", "AttemptLifecycleService", request, { kind: "process_receipt", processReceiptId: request.processReceiptId });
  }

  beginReview(request: ContextGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "implementation_captured", "reviewing", "ReviewService", request, { kind: "execution_context", contextId: request.contextId });
  }

  queueVerification(request: ReviewGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "reviewing", "verification_queued", "ReviewService", request, { kind: "review_record", reviewRecordId: request.reviewRecordId, verdict: "accepted" });
  }

  beginRemediation(request: ReviewGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "reviewing", "remediating", "ReviewService", request, { kind: "review_record", reviewRecordId: request.reviewRecordId, verdict: "rejected" });
  }

  captureRemediation(request: RemediationGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "remediating", "remediation_captured", "RemediationService", request, { kind: "remediation_record", remediationRecordId: request.remediationRecordId });
  }

  beginReviewAfterRemediation(request: ContextGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "remediation_captured", "reviewing", "ReviewService", request, { kind: "execution_context", contextId: request.contextId });
  }

  beginVerification(request: ContextGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "verification_queued", "verifying", "VerificationService", request, { kind: "execution_context", contextId: request.contextId });
  }

  completeVerification(request: GateGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "verifying", "converging", "VerificationService", request, { kind: "gate_results", gateResultIds: Object.freeze([...request.gateResultIds]) });
  }

  beginAttemptCleanup(request: CleanupPendingAttemptRequest): TransitionResult {
    const guard: TransitionGuard = request.commitAttributionId === undefined
      ? { kind: "cleanup_pending" }
      : { kind: "cleanup_pending", commitAttributionId: request.commitAttributionId };
    return this.#commit("attempt", request.attemptId, "converging", "cleanup_pending", "AttemptLifecycleService", request, guard);
  }

  markAttemptFailedClean(request: CleanupGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "cleanup_pending", "failed_clean", "CleanupService", request, { kind: "cleanup_record", cleanupRecordId: request.cleanupRecordId, outcome: "failed_clean" });
  }

  quarantineAttempt(request: CleanupGuardedAttemptRequest): TransitionResult {
    return this.#commit("attempt", request.attemptId, "cleanup_pending", "quarantined", "CleanupService", request, { kind: "cleanup_record", cleanupRecordId: request.cleanupRecordId, outcome: "quarantined" });
  }

  beginTicketCleanup(request: TicketCleanupRequest): TransitionResult {
    return this.#commit("ticket", request.ticketInstanceId, "active", "cleanup_pending", "AttemptLifecycleService", request, { kind: "ticket_attempt_cleanup", attemptId: request.attemptId });
  }

  failTicket(request: TicketFailureRequest): TransitionResult {
    return this.#commit("ticket", request.ticketInstanceId, "cleanup_pending", "failed", "CleanupService", request, { kind: "ticket_failure", attemptId: request.attemptId, cleanupRecordId: request.cleanupRecordId, quarantined: false });
  }

  quarantineTicket(request: TicketFailureRequest): TransitionResult {
    return this.#commit("ticket", request.ticketInstanceId, "cleanup_pending", "quarantined", "CleanupService", request, { kind: "ticket_failure", attemptId: request.attemptId, cleanupRecordId: request.cleanupRecordId, quarantined: true });
  }

  beginRunCleanup(request: BeginRunCleanupRequest): TransitionResult {
    return this.#commit("run", request.runId, "active", "cleanup_pending", "RunLifecycleService", request, { kind: "run_cleanup_begin", attemptId: request.attemptId });
  }

  reactivateRun(request: ReactivateRunRequest): TransitionResult {
    return this.#commit("run", request.runId, "cleanup_pending", "active", "RunLifecycleService", request, { kind: "run_cleanup_complete", cleanupRecordId: request.cleanupRecordId });
  }

  finalizeActiveRunFailure(request: RunFailureRequest): TransitionResult {
    return this.#commit("run", request.runId, "active", "failed", "RunFinalizationService", request, { kind: "run_failure", cleanupRecordId: request.cleanupRecordId });
  }

  finalizeFailedRun(request: RunFailureRequest): TransitionResult {
    return this.#commit("run", request.runId, "cleanup_pending", "failed", "RunFinalizationService", request, { kind: "run_failure", cleanupRecordId: request.cleanupRecordId });
  }

  finalizeReadyRun(request: RunTransitionRequest): TransitionResult {
    return this.#commit("run", request.runId, "active", "ready_for_delivery", "RunFinalizationService", request, { kind: "run_ready" });
  }

}

export interface PromotionRequest {
  readonly promotionIntentId: string;
  readonly expectedVersion: number;
  readonly ownerContextDigest: string;
  readonly idempotencyKey: string;
  readonly evidence: TransitionEvidenceReference;
}

export interface PromotionIntentRequest {
  readonly promotionIntentId: string;
  readonly runId: string;
  readonly ticketInstanceId: string;
  readonly attemptId: string;
  readonly promotionSequence: number;
  readonly deliveryRef: string;
  readonly expectedOldOid: string;
  readonly candidateOid: string;
  readonly oracleDecisionId: string;
  readonly commitAttributionId: string;
  readonly ownerContextId: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface AtomicPromotionTransitionRequest {
  readonly idempotencyKey: string;
  readonly evidence: readonly TransitionEvidenceReference[];
}

export interface PromotionObservationRequest extends PromotionRequest {
  readonly observedOid: string;
}

export interface PromotionFinalizationRequest extends PromotionRequest {
  readonly expectedRunVersion: number;
  readonly cleanupRecordId: string;
  readonly attemptId: string;
  readonly ticketInstanceId: string;
  readonly oracleDecisionId: string;
  readonly attemptExpectedVersion: number;
  readonly ticketExpectedVersion: number;
  readonly oracleEvaluation: AtomicPromotionTransitionRequest;
  readonly verifiedAttempt: AtomicPromotionTransitionRequest;
  readonly readyTicket: AtomicPromotionTransitionRequest;
}

export interface PromotionResult {
  readonly promotionIntentId: string;
  readonly fromState: string;
  readonly toState: string;
  readonly stateVersion: number;
  readonly observedOid: string | null;
  readonly observationEvidenceId: string | null;
  readonly finalizationEvidenceId: string | null;
  readonly runStateVersion: number | null;
  readonly oracleEvaluationTransition?: TransitionResult;
  readonly verifiedAttemptTransition?: TransitionResult;
  readonly readyTicketTransition?: TransitionResult;
}

export interface PromotionFinalizationTransitions {
  readonly oracleEvaluation: TransitionCommit;
  readonly verifiedAttempt: TransitionCommit;
  readonly readyTicket: TransitionCommit;
}

export type PromotionGuard =
  | { readonly kind: "observe_old"; readonly observedOid: string }
  | { readonly kind: "observe_candidate"; readonly observedOid: string }
  | { readonly kind: "observe_conflict"; readonly observedOid: string }
  | {
      readonly kind: "finalize";
      readonly expectedRunVersion: number;
      readonly cleanupRecordId: string;
      readonly attemptId: string;
      readonly ticketInstanceId: string;
      readonly oracleDecisionId: string;
      readonly attemptExpectedVersion: number;
      readonly ticketExpectedVersion: number;
      readonly oracleEvaluationIdempotencyKey: string;
      readonly verifiedAttemptIdempotencyKey: string;
      readonly readyTicketIdempotencyKey: string;
    };

export function promotionOperationEvidencePayload(input: {
  readonly promotionIntentId: string;
  readonly expectedVersion: number;
  readonly fromState: string;
  readonly toState: string;
  readonly ownerContextDigest: string;
  readonly guard: PromotionGuard;
}): Readonly<Record<string, unknown>> {
  return Object.freeze({
    promotion_intent_id: input.promotionIntentId,
    expected_version: input.expectedVersion,
    from_state: input.fromState,
    to_state: input.toState,
    owner_context_digest: input.ownerContextDigest,
    guard: input.guard,
  });
}

const PROMOTION_INTENT_COMMIT_AUTHORITY = Symbol("rickgent.promotion-intent-authority");
const AUTHORIZED_PROMOTION_INTENT_COMMITS = new WeakSet<object>();

export class PromotionIntentCommit {
  constructor(authority: symbol, readonly request: PromotionIntentRequest) {
    if (authority !== PROMOTION_INTENT_COMMIT_AUTHORITY) throw new TypeError("promotion intent commits can only be minted by PromotionAuthority");
    Object.freeze(this.request);
    Object.freeze(this);
    AUTHORIZED_PROMOTION_INTENT_COMMITS.add(this);
  }
}

export function isAuthorizedPromotionIntentCommit(value: unknown): value is PromotionIntentCommit {
  return typeof value === "object" && value !== null && AUTHORIZED_PROMOTION_INTENT_COMMITS.has(value);
}

const PROMOTION_COMMIT_AUTHORITY = Symbol("rickgent.promotion-authority");
const AUTHORIZED_PROMOTION_COMMITS = new WeakSet<object>();

export class PromotionCommit {
  constructor(
    authority: symbol,
    readonly promotionIntentId: string,
    readonly fromState: string,
    readonly toState: string,
    readonly expectedVersion: number,
    readonly ownerContextDigest: string,
    readonly idempotencyKey: string,
    readonly evidence: TransitionEvidenceReference,
    readonly guard: PromotionGuard,
    readonly finalizationTransitions: PromotionFinalizationTransitions | null = null,
  ) {
    if (authority !== PROMOTION_COMMIT_AUTHORITY) throw new TypeError("promotion commits can only be minted by PromotionAuthority");
    Object.freeze(this.evidence);
    Object.freeze(this.guard);
    if (this.finalizationTransitions !== null) Object.freeze(this.finalizationTransitions);
    Object.freeze(this);
    AUTHORIZED_PROMOTION_COMMITS.add(this);
  }
}

export function isAuthorizedPromotionCommit(value: unknown): value is PromotionCommit {
  return typeof value === "object" && value !== null && AUTHORIZED_PROMOTION_COMMITS.has(value);
}

/** TicketFinalizationService-owned promotion edges. No generic edge writer is exposed. */
export class PromotionAuthority {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  createIntent(request: PromotionIntentRequest): StateRecord {
    return this.#store.createAuthorizedPromotionIntent(new PromotionIntentCommit(
      PROMOTION_INTENT_COMMIT_AUTHORITY,
      Object.freeze({ ...request }),
    ));
  }

  #evidence(from: string, to: string, request: PromotionRequest, guard: PromotionGuard): InlineTransitionEvidenceReference {
    if (!("inlineEvidence" in request.evidence)) throw new TypeError("promotion operations require authority-generated inline evidence");
    if (
      request.evidence.purpose !== "promotion-operation" ||
      request.evidence.inlineEvidence.producerService !== "TicketFinalizationService" ||
      request.evidence.inlineEvidence.scope !== request.promotionIntentId ||
      request.evidence.inlineEvidence.schemaVersion !== "rickgent.promotion-operation.v1" ||
      request.evidence.inlineEvidence.idempotencyKey !== request.idempotencyKey
    ) return Object.freeze({ ...request.evidence });
    return Object.freeze({
      purpose: request.evidence.purpose,
      inlineEvidence: Object.freeze({
        contextId: request.evidence.inlineEvidence.contextId,
        producerService: "TicketFinalizationService",
        scope: request.promotionIntentId,
        schemaVersion: "rickgent.promotion-operation.v1",
        payload: promotionOperationEvidencePayload({
          promotionIntentId: request.promotionIntentId,
          expectedVersion: request.expectedVersion,
          fromState: from,
          toState: to,
          ownerContextDigest: request.ownerContextDigest,
          guard,
        }),
        idempotencyKey: request.idempotencyKey,
      }),
    });
  }

  #commit(
    from: string,
    to: string,
    request: PromotionRequest,
    guard: PromotionGuard,
    finalizationTransitions: PromotionFinalizationTransitions | null = null,
  ): PromotionResult {
    const evidence = this.#evidence(from, to, request, guard);
    return this.#store.commitAuthorizedPromotion(new PromotionCommit(
      PROMOTION_COMMIT_AUTHORITY,
      request.promotionIntentId,
      from,
      to,
      request.expectedVersion,
      request.ownerContextDigest,
      request.idempotencyKey,
      evidence,
      guard,
      finalizationTransitions,
    ));
  }

  observeOld(request: PromotionObservationRequest): PromotionResult {
    return this.#commit("intent_recorded", "ref_observed_old", request, { kind: "observe_old", observedOid: request.observedOid });
  }

  observeCandidate(request: PromotionObservationRequest): PromotionResult {
    return this.#commit("intent_recorded", "ref_observed_candidate", request, { kind: "observe_candidate", observedOid: request.observedOid });
  }

  observeCandidateAfterOld(request: PromotionObservationRequest): PromotionResult {
    return this.#commit("ref_observed_old", "ref_observed_candidate", request, { kind: "observe_candidate", observedOid: request.observedOid });
  }

  conflictFromIntent(request: PromotionObservationRequest): PromotionResult {
    return this.#commit("intent_recorded", "conflicted", request, { kind: "observe_conflict", observedOid: request.observedOid });
  }

  conflictAfterOld(request: PromotionObservationRequest): PromotionResult {
    return this.#commit("ref_observed_old", "conflicted", request, { kind: "observe_conflict", observedOid: request.observedOid });
  }

  conflictAfterCandidate(request: PromotionObservationRequest): PromotionResult {
    return this.#commit("ref_observed_candidate", "conflicted", request, { kind: "observe_conflict", observedOid: request.observedOid });
  }

  finalize(request: PromotionFinalizationRequest): PromotionResult {
    const guard: PromotionGuard = {
      kind: "finalize",
      expectedRunVersion: request.expectedRunVersion,
      cleanupRecordId: request.cleanupRecordId,
      attemptId: request.attemptId,
      ticketInstanceId: request.ticketInstanceId,
      oracleDecisionId: request.oracleDecisionId,
      attemptExpectedVersion: request.attemptExpectedVersion,
      ticketExpectedVersion: request.ticketExpectedVersion,
      oracleEvaluationIdempotencyKey: request.oracleEvaluation.idempotencyKey,
      verifiedAttemptIdempotencyKey: request.verifiedAttempt.idempotencyKey,
      readyTicketIdempotencyKey: request.readyTicket.idempotencyKey,
    };
    const finalizationEvidence = this.#evidence("ref_observed_candidate", "finalized", request, guard);
    const transitionRequest = (
      expectedVersion: number,
      input: AtomicPromotionTransitionRequest,
    ): TransitionRequest => ({
      expectedVersion,
      ownerContextDigest: request.ownerContextDigest,
      idempotencyKey: input.idempotencyKey,
      evidence: input.evidence.map((reference) =>
        "inlineEvidence" in reference && reference.inlineEvidence.idempotencyKey === request.idempotencyKey
          ? finalizationEvidence
          : reference
      ),
    });
    const transitions: PromotionFinalizationTransitions = Object.freeze({
      oracleEvaluation: authorizedCommit(
        "attempt",
        request.attemptId,
        "cleanup_pending",
        "oracle_evaluation",
        "TicketFinalizationService",
        transitionRequest(request.attemptExpectedVersion, request.oracleEvaluation),
        { kind: "oracle_promotion", oracleDecisionId: request.oracleDecisionId, promotionIntentId: request.promotionIntentId },
      ),
      verifiedAttempt: authorizedCommit(
        "attempt",
        request.attemptId,
        "oracle_evaluation",
        "verified",
        "TicketFinalizationService",
        transitionRequest(request.attemptExpectedVersion + 1, request.verifiedAttempt),
        { kind: "verified_promotion", oracleDecisionId: request.oracleDecisionId, promotionIntentId: request.promotionIntentId, cleanupRecordId: request.cleanupRecordId },
      ),
      readyTicket: authorizedCommit(
        "ticket",
        request.ticketInstanceId,
        "cleanup_pending",
        "ready_for_delivery",
        "TicketFinalizationService",
        transitionRequest(request.ticketExpectedVersion, request.readyTicket),
        { kind: "ticket_finalization", attemptId: request.attemptId, cleanupRecordId: request.cleanupRecordId, oracleDecisionId: request.oracleDecisionId, promotionIntentId: request.promotionIntentId },
      ),
    });
    return this.#commit("ref_observed_candidate", "finalized", request, guard, transitions);
  }
}

export interface DeliveryOwnerRequest {
  readonly ownerContextId: string;
  readonly ownerContextDigest: string;
}

export interface DeliveryIntentRequest extends DeliveryOwnerRequest {
  readonly deliveryIntentId: string;
  readonly runId: string;
  readonly deliveryOid: string;
  readonly remoteName: string;
  readonly branchName: string;
  readonly expectedRemoteOid: string | null;
  readonly baseBranch: string;
  readonly providerIdentityDigest: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface DeliveryEvidenceRequest extends DeliveryOwnerRequest {
  readonly deliveryIntentId: string;
  readonly evidenceIdempotencyKey: string;
  readonly createdAt: string;
}

export interface RemoteObservationRequest extends DeliveryEvidenceRequest {
  readonly remoteObservationId: string;
  readonly sequence: number;
  readonly operation: string;
  readonly outcome: string;
  readonly observedRemoteOid: string | null;
}

export interface PrObservationRequest extends DeliveryEvidenceRequest {
  readonly prObservationId: string;
  readonly sequence: number;
  readonly providerRepositoryId: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly prIdentity: string;
  readonly observedHeadOid: string;
}

export interface DeliveryDecisionRequest extends DeliveryEvidenceRequest {
  readonly deliveryRecordId: string;
  readonly terminalFromState: "intent_recorded" | "remote_observed" | "pr_observed";
  readonly remoteObservationId: string | null;
  readonly prObservationId: string | null;
  readonly cleanupRecordId: string;
  readonly deliveryOid: string;
  readonly decision: "delivered" | "delivery_failed";
  readonly runId: string;
  readonly expectedRunVersion: number;
  readonly transitionIdempotencyKey: string;
  readonly transitionEvidence: readonly TransitionEvidenceReference[];
}

export type DeliveryCommandRequest =
  | { readonly kind: "intent"; readonly request: DeliveryIntentRequest }
  | { readonly kind: "remote_observation"; readonly request: RemoteObservationRequest }
  | { readonly kind: "pr_observation"; readonly request: PrObservationRequest }
  | { readonly kind: "decision"; readonly request: DeliveryDecisionRequest; readonly terminalTransition: TransitionCommit };

export function deliveryDecisionEvidencePayload(request: DeliveryDecisionRequest): Readonly<Record<string, unknown>> {
  return Object.freeze({
    delivery_intent_id: request.deliveryIntentId,
    delivery_record_id: request.deliveryRecordId,
    terminal_from_state: request.terminalFromState,
    remote_observation_id: request.remoteObservationId,
    pr_observation_id: request.prObservationId,
    cleanup_record_id: request.cleanupRecordId,
    delivery_oid: request.deliveryOid,
    decision: request.decision,
    run_id: request.runId,
    expected_run_version: request.expectedRunVersion,
    transition_idempotency_key: request.transitionIdempotencyKey,
  });
}

const DELIVERY_COMMAND_AUTHORITY = Symbol("rickgent.delivery-authority");
const AUTHORIZED_DELIVERY_COMMANDS = new WeakSet<object>();

export class DeliveryCommand {
  constructor(authority: symbol, readonly command: DeliveryCommandRequest) {
    if (authority !== DELIVERY_COMMAND_AUTHORITY) throw new TypeError("delivery commands can only be minted by DeliveryAuthority");
    Object.freeze(this.command.request);
    Object.freeze(this.command);
    Object.freeze(this);
    AUTHORIZED_DELIVERY_COMMANDS.add(this);
  }
}

export function isAuthorizedDeliveryCommand(value: unknown): value is DeliveryCommand {
  return typeof value === "object" && value !== null && AUTHORIZED_DELIVERY_COMMANDS.has(value);
}

/** DeliveryService-owned immutable intent, observation, and decision operations. */
export class DeliveryAuthority {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  #commit(command: DeliveryCommandRequest): StateRecord {
    return this.#store.commitAuthorizedDelivery(new DeliveryCommand(DELIVERY_COMMAND_AUTHORITY, command));
  }

  createIntent(request: DeliveryIntentRequest): StateRecord {
    return this.#commit({ kind: "intent", request: Object.freeze({ ...request }) });
  }

  recordRemoteObservation(request: RemoteObservationRequest): StateRecord {
    return this.#commit({ kind: "remote_observation", request: Object.freeze({ ...request }) });
  }

  recordPrObservation(request: PrObservationRequest): StateRecord {
    return this.#commit({ kind: "pr_observation", request: Object.freeze({ ...request }) });
  }

  recordDecision(request: DeliveryDecisionRequest): StateRecord {
    const decisionEvidence: InlineTransitionEvidenceReference = Object.freeze({
      purpose: "delivery_decision",
      inlineEvidence: Object.freeze({
        contextId: request.ownerContextId,
        producerService: "DeliveryService",
        scope: request.deliveryIntentId,
        schemaVersion: "rickgent.delivery-decision.v1",
        payload: deliveryDecisionEvidencePayload(request),
        idempotencyKey: request.evidenceIdempotencyKey,
      }),
    });
    const terminalTransition = authorizedCommit(
      "run",
      request.runId,
      "ready_for_delivery",
      request.decision,
      "DeliveryService",
      {
        expectedVersion: request.expectedRunVersion,
        ownerContextDigest: request.ownerContextDigest,
        idempotencyKey: request.transitionIdempotencyKey,
        evidence: Object.freeze([...request.transitionEvidence, decisionEvidence]),
      },
      { kind: "delivery_record", deliveryRecordId: request.deliveryRecordId, decision: request.decision },
    );
    return this.#commit({ kind: "decision", request: Object.freeze({ ...request }), terminalTransition });
  }
}

export interface ProcessReceiptRecordRequest {
  readonly processReceiptId: string;
  readonly phaseExecutionId: string;
  readonly attemptId: string;
  readonly contextId: string;
  readonly ownerContextDigest: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly pid: number;
  readonly pgid: number;
  readonly bootIdentity: string;
  readonly processStartIdentity: string;
  readonly argvDigest: string;
  readonly environmentDigest: string;
  readonly launchEvidenceId: string;
  readonly exitEvidenceId: string;
  readonly terminationEvidenceId: string | null;
  readonly groupDeathEvidenceId: string | null;
  readonly stdoutEvidenceId: string | null;
  readonly stderrEvidenceId: string | null;
  readonly createdAt: string;
}

export interface ReviewRecordRequest {
  readonly reviewRecordId: string;
  readonly attemptId: string;
  readonly cycle: number;
  readonly reviewerContextId: string;
  readonly ownerContextDigest: string;
  readonly verdict: "accepted" | "rejected";
  readonly verdictEvidenceId: string;
  readonly findingsEvidenceId: string;
  readonly inputTreeOid: string;
  readonly inputDiffDigest: string;
  readonly createdAt: string;
}

export interface RemediationRecordRequest {
  readonly remediationRecordId: string;
  readonly attemptId: string;
  readonly cycle: number;
  readonly contextId: string;
  readonly ownerContextDigest: string;
  readonly findingsEvidenceId: string;
  readonly outputEvidenceId: string;
  readonly resultTreeOid: string;
  readonly resultDiffDigest: string;
  readonly createdAt: string;
}

export interface GateResultRecordRequest {
  readonly gateResultId: string;
  readonly attemptId: string;
  readonly gateId: string;
  readonly evaluationOrdinal: number;
  readonly status: "passed" | "failed" | "missing" | "null" | "skipped" | "unavailable" | "infrastructure_error" | "stale" | "conflicting";
  readonly required: boolean;
  readonly contextId: string;
  readonly ownerContextDigest: string;
  readonly contractDigest: string;
  readonly evidenceId: string;
  /** Candidate tree evaluated by this gate, independently resolved by StateStore. */
  readonly candidateTreeOid: string;
  /** Canonical baseline-to-candidate Git delta digest, independently derived by StateStore. */
  readonly candidateDiffDigest: string;
  readonly createdAt: string;
}

export interface CommitAttributionRecordRequest {
  readonly commitAttributionId: string;
  readonly attemptId: string;
  readonly baselineOid: string;
  readonly parentOid: string;
  readonly treeBeforeOid: string;
  readonly treeAfterOid: string;
  readonly commitOid: string;
  readonly contractDigest: string;
  readonly contextDigest: string;
  readonly pathSetDigest: string;
  readonly changeKindSetDigest: string;
  readonly modeSetDigest: string;
  readonly attributionEvidenceId: string;
  readonly createdAt: string;
}

export interface CleanupRecordRequest {
  readonly cleanupRecordId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly contextId: string;
  readonly ownerContextDigest: string;
  readonly outcome: string;
  readonly groupDead: boolean;
  readonly worktreeDisposition: string;
  readonly indexDisposition: string;
  readonly refDisposition: string;
  readonly contextDisposition: string;
  readonly bundleDisposition: string;
  readonly deliveryRefObservedOid: string;
  readonly resourcesAbsent: boolean;
  readonly leaseReleaseEligible: boolean;
  readonly evidenceId: string;
  readonly createdAt: string;
}

export type LifecycleRecordCommandRequest =
  | { readonly kind: "review_record"; readonly request: ReviewRecordRequest }
  | { readonly kind: "remediation_record"; readonly request: RemediationRecordRequest }
  | { readonly kind: "gate_result"; readonly request: GateResultRecordRequest }
  | { readonly kind: "cleanup_record"; readonly request: CleanupRecordRequest };

const LIFECYCLE_RECORD_AUTHORITY = Symbol("rickgent.lifecycle-record-authority");
const AUTHORIZED_LIFECYCLE_RECORD_COMMANDS = new WeakSet<object>();

export class LifecycleRecordCommand {
  constructor(authority: symbol, readonly command: LifecycleRecordCommandRequest) {
    if (authority !== LIFECYCLE_RECORD_AUTHORITY) throw new TypeError("lifecycle record commands can only be minted by LifecycleRecordAuthority");
    Object.freeze(this.command.request);
    Object.freeze(this.command);
    Object.freeze(this);
    AUTHORIZED_LIFECYCLE_RECORD_COMMANDS.add(this);
  }
}

export function isAuthorizedLifecycleRecordCommand(value: unknown): value is LifecycleRecordCommand {
  return typeof value === "object" && value !== null && AUTHORIZED_LIFECYCLE_RECORD_COMMANDS.has(value);
}

/** Service-owned creation of immutable lifecycle proof rows consumed by TransitionAuthority. */
export class LifecycleRecordAuthority {
  readonly #store: StateStore;

  constructor(store: StateStore) {
    this.#store = store;
  }

  #commit(command: LifecycleRecordCommandRequest): StateRecord {
    return this.#store.commitAuthorizedLifecycleRecord(new LifecycleRecordCommand(LIFECYCLE_RECORD_AUTHORITY, command));
  }

  recordProcessReceipt(request: ProcessReceiptRecordRequest): StateRecord {
    void request;
    throw new TypeError("legacy process receipts are migration-compatible read models; only ProcessSupervisor may produce current process truth");
  }

  recordReview(request: ReviewRecordRequest): StateRecord {
    return this.#commit({ kind: "review_record", request: Object.freeze({ ...request }) });
  }

  recordRemediation(request: RemediationRecordRequest): StateRecord {
    return this.#commit({ kind: "remediation_record", request: Object.freeze({ ...request }) });
  }

  recordGateResult(request: GateResultRecordRequest): StateRecord {
    return this.#commit({ kind: "gate_result", request: Object.freeze({ ...request }) });
  }

  recordCommitAttribution(request: CommitAttributionRecordRequest): StateRecord {
    void request;
    throw new TypeError("legacy commit attributions are migration-compatible read models; only CommitService may create current attribution truth");
  }

  recordCleanup(request: CleanupRecordRequest): StateRecord {
    return this.#commit({ kind: "cleanup_record", request: Object.freeze({ ...request }) });
  }
}
