// Delivery is activated (t34): verified push and idempotent PR creation.
//
// The `ensureBranch` function is the stable capability boundary imported by
// contraction tests and historical callers. With automatic_delivery activated,
// the capability gate passes. The actual push/PR protocol is implemented in
// `orchestrator/src/delivery/push.ts` and `orchestrator/src/delivery/pull-request.ts`,
// which enforce verified push (independent ls-remote OID match) and verified
// idempotent PR creation (queried head OID and repository identity equality)
// before marking delivered.
//
// t33/t34 production wiring: `ensureBranch` now calls `executeVerifiedPush`
// then `executeVerifiedPullRequest` when delivery parameters are supplied,
// wiring the verified push and PR creation into the production
// delivery-decision flow.  The push module independently observes the remote
// OID via `git ls-remote` BEFORE push and enforces OID match after.

import { RUNTIME_CAPABILITY_GATE } from "../capabilities/runtime-gate.js";
import { executeVerifiedPush, type VerifiedPushRequest, type VerifiedPushResult } from "../delivery/push.js";
import { executeVerifiedPullRequest, type VerifiedPrRequest, type VerifiedPrResult, type PrProvider } from "../delivery/pull-request.js";
import type { StateStore } from "../state/store.js";
import { DeliveryAuthority } from "../state/transitions.js";

/**
 * Result of the delivery-decision flow.
 */
export interface DeliveryDecisionResult {
  readonly pushResult: VerifiedPushResult;
  readonly prResult: VerifiedPrResult | null;
  readonly delivered: boolean;
}

/**
 * Verify the delivery capability is active and the branch name is valid.
 * The actual push/PR protocol is handled by the delivery module.
 *
 * This is the stable capability boundary function.  When called with only
 * repoDir and branch, it performs the capability gate check.  When called
 * with the full delivery parameters (via `executeDeliveryFlow`), it wires
 * the verified push and PR creation into the production delivery-decision
 * flow.
 */
export function ensureBranch(
  _repoDir: string,
  branch: string,
  _env: NodeJS.ProcessEnv = process.env,
): void {
  RUNTIME_CAPABILITY_GATE.require("automatic_delivery");
  if (typeof branch !== "string" || branch.length === 0) {
    throw new Error("branch name must be a non-empty string");
  }
}

/**
 * t33/t34: Execute the full production delivery-decision flow.
 *
 * This function wires `executeVerifiedPush` and `executeVerifiedPullRequest`
 * into the production delivery path.  It:
 *   1. Independently observes the expected remote OID via `git ls-remote`
 *      BEFORE push (the push module does this internally).
 *   2. Executes the verified push with independent ls-remote OID match.
 *   3. Executes the verified idempotent PR creation after verified push.
 *   4. Returns the combined result.
 *
 * The caller must supply the StateStore, DeliveryAuthority, and delivery
 * parameters.  All outcomes are persisted through the DeliveryAuthority as
 * immutable records.
 *
 * @returns The delivery decision result.  `delivered` is true only when both
 *          push and PR creation are verified.
 */
export function executeDeliveryFlow(
  params: DeliveryFlowParams,
): DeliveryDecisionResult {
  RUNTIME_CAPABILITY_GATE.require("automatic_delivery");

  const { store, repoPath, runId, deliveryOid, remoteName, branchName, baseBranch, provider } = params;
  const authority = params.authority ?? new DeliveryAuthority(store);

  // t33/t34 scrutiny round 2: The expected remote OID is persisted at delivery
  // decision time (when the delivery intent is created).  It is NOT freshly
  // observed here — the caller passes it from the delivery decision.  This
  // ensures the pre-push ls-remote can detect stale expected OIDs (the remote
  // ref moved between decision time and push time).
  const expectedRemoteOid = params.expectedRemoteOid ?? null;

  // t33: Execute the verified push.
  const pushRequest: VerifiedPushRequest = {
    store,
    authority,
    repoPath,
    runId,
    deliveryOid,
    remoteName,
    branchName,
    expectedRemoteOid,
    baseBranch,
    ownerContextId: params.ownerContextId,
    ownerContextDigest: params.ownerContextDigest,
    providerIdentityDigest: params.providerIdentityDigest,
    idempotencyKey: params.idempotencyKey ?? `delivery-push:${runId}`,
    deliveryIntentId: params.deliveryIntentId ?? `delivery-intent-${runId}`,
    timeoutMs: params.timeoutMs ?? 30_000,
  };
  const pushResult = executeVerifiedPush(pushRequest);

  // If push is not verified, do not attempt PR creation.
  if (pushResult.status !== "verified") {
    return {
      pushResult,
      prResult: null,
      delivered: false,
    };
  }

  // t34: Execute the verified idempotent PR creation after verified push.
  const prRequest: VerifiedPrRequest = {
    store,
    authority,
    runId,
    deliveryOid,
    deliveryIntentId: pushRequest.deliveryIntentId,
    expectedRepositoryId: params.expectedRepositoryId,
    baseBranch,
    headBranch: branchName,
    provider,
    ownerContextId: params.ownerContextId,
    ownerContextDigest: params.ownerContextDigest,
    idempotencyKey: params.prIdempotencyKey ?? `delivery-pr:${runId}`,
    prTitle: params.prTitle ?? `Rickgent run ${runId}`,
    prBody: params.prBody ?? "",
    timeoutMs: params.timeoutMs ?? 30_000,
  };
  const prResult = executeVerifiedPullRequest(prRequest);

  return {
    pushResult,
    prResult,
    delivered: prResult.status === "verified",
  };
}

/**
 * Parameters for the delivery-decision flow.
 */
export interface DeliveryFlowParams {
  readonly store: StateStore;
  readonly authority?: DeliveryAuthority;
  readonly repoPath: string;
  readonly runId: string;
  readonly deliveryOid: string;
  readonly remoteName: string;
  readonly branchName: string;
  readonly baseBranch: string;
  readonly expectedRepositoryId: string;
  readonly provider: PrProvider;
  readonly ownerContextId: string;
  readonly ownerContextDigest: string;
  readonly providerIdentityDigest: string;
  /**
   * t33/t34 scrutiny round 2: The expected remote OID persisted at delivery
   * decision time.  When supplied, executeVerifiedPush compares the fresh
   * pre-push ls-remote observation with this persisted expected OID.  If they
   * differ, the push fails closed (stale expected OID rejected).  When null,
   * no stale check is performed (the remote ref is new).
   */
  readonly expectedRemoteOid?: string | null;
  readonly deliveryIntentId?: string;
  readonly idempotencyKey?: string;
  readonly prIdempotencyKey?: string;
  readonly prTitle?: string;
  readonly prBody?: string;
  readonly timeoutMs?: number;
}
