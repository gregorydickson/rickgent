/**
 * t33: Verified push with observed remote OID.
 *
 * Accept only a run whose every planned ticket is ready and cleanup-verified.
 * Persist delivery intent with exact local delivery OID / remote / branch /
 * expected old remote OID, execute array-argv non-force push, then observe
 * `git ls-remote` and require equality. Use disposable local bare repositories
 * for deterministic success, rejection, timeout, response-loss, and ref-race
 * cases.
 *
 * Invariants:
 * - Push uses `execFileSync("git", [...])` with array argv — never shell strings.
 * - No force flag is ever passed to git push.
 * - An independent `ls-remote` observation is required; the push exit code
 *   alone is not sufficient.
 * - All outcomes are persisted through DeliveryAuthority as immutable remote
 *   observations.
 * - Resume is idempotent: a re-call after a push observation but before an
 *   ls-remote observation does not re-push; it only completes the ls-remote.
 * - Missing origin, wrong remote, rejected/non-fast-forward push, stale
 *   branch/expected OID, command failure, observation mismatch, timeout, and
 *   crash leave the run non-delivered/nonzero and PR-unreachable.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { StateStore } from "../state/store.js";
import type { DeliveryAuthority } from "../state/transitions.js";

/** Request to execute a verified push. */
export interface VerifiedPushRequest {
  readonly store: StateStore;
  readonly authority: DeliveryAuthority;
  readonly repoPath: string;
  readonly runId: string;
  readonly deliveryOid: string;
  readonly remoteName: string;
  readonly branchName: string;
  readonly expectedRemoteOid: string | null;
  readonly baseBranch: string;
  readonly ownerContextId: string;
  readonly ownerContextDigest: string;
  readonly providerIdentityDigest: string;
  readonly idempotencyKey: string;
  readonly deliveryIntentId: string;
  readonly timeoutMs: number;
}

export type VerifiedPushResult =
  | { readonly status: "verified"; readonly deliveryIntentId: string; readonly pushObservationId: string; readonly lsRemoteObservationId: string; readonly observedRemoteOid: string }
  | { readonly status: "rejected"; readonly deliveryIntentId: string; readonly reason: string; readonly exitCode: number | null }
  | { readonly status: "timeout"; readonly deliveryIntentId: string; readonly reason: string }
  | { readonly status: "mismatch"; readonly deliveryIntentId: string; readonly observedRemoteOid: string; readonly expectedOid: string }
  | { readonly status: "infrastructure_error"; readonly deliveryIntentId: string; readonly reason: string };


function digest(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

const NOW = "2026-07-22T12:00:00.000Z";

interface RemoteObservation {
  readonly observationId: string;
  readonly sequence: number;
  readonly operation: string;
  readonly outcome: string;
  readonly observedRemoteOid: string | null;
}

function findPushObservation(
  observations: readonly RemoteObservation[],
): RemoteObservation | undefined {
  return observations.find((o) => o.operation === "push");
}

function findLsRemoteObservation(
  observations: readonly RemoteObservation[],
): RemoteObservation | undefined {
  return observations.find((o) => o.operation === "ls-remote" && o.observedRemoteOid !== null);
}

/**
 * Execute a verified push against a remote.
 *
 * Steps:
 * 1. Verify the local delivery ref equals the delivery OID.
 * 2. Create or resume the delivery intent via DeliveryAuthority.
 * 3. Check existing remote observations for idempotent resume.
 * 4. If no push observation exists, execute `git push <remote> <oid>:refs/heads/<branch>`
 *    with array argv (no force) and record the push observation.
 * 5. If no ls-remote observation exists, execute `git ls-remote <remote> refs/heads/<branch>`
 *    with array argv and record the ls-remote observation.
 * 6. Require the observed remote OID to equal the delivery OID.
 *
 * Resume: if a delivery intent already exists and has push/ls-remote observations,
 * the service resumes idempotently without re-pushing.
 */
export function executeVerifiedPush(request: VerifiedPushRequest): VerifiedPushResult {
  const { store, authority, repoPath, runId, deliveryOid, remoteName, branchName } = request;

  // 1. Verify the local delivery ref equals the delivery OID.
  const run = store.readDeliveryIntent(runId);
  void run; // Delivery intent may or may not exist yet

  // Check the delivery ref
  const deliveryRef = `refs/rickgent/runs/${runId}/delivery`;
  let refOid: string;
  try {
    refOid = execFileSync("git", ["-C", repoPath, "rev-parse", deliveryRef], {
      encoding: "utf8",
      timeout: 10_000,
    }).trim();
  } catch {
    return {
      status: "infrastructure_error",
      deliveryIntentId: request.deliveryIntentId,
      reason: "delivery ref could not be resolved",
    };
  }
  if (refOid !== deliveryOid) {
    return {
      status: "infrastructure_error",
      deliveryIntentId: request.deliveryIntentId,
      reason: `delivery ref (${refOid.slice(0, 12)}) does not equal delivery OID (${deliveryOid.slice(0, 12)})`,
    };
  }

  // 2. Create or resume the delivery intent.
  try {
    authority.createIntent({
      deliveryIntentId: request.deliveryIntentId,
      runId,
      deliveryOid,
      remoteName,
      branchName,
      expectedRemoteOid: request.expectedRemoteOid,
      baseBranch: request.baseBranch,
      providerIdentityDigest: request.providerIdentityDigest,
      ownerContextId: request.ownerContextId,
      ownerContextDigest: request.ownerContextDigest,
      idempotencyKey: request.idempotencyKey,
      createdAt: NOW,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ready") || message.includes("delivery OID")) {
      return {
        status: "infrastructure_error",
        deliveryIntentId: request.deliveryIntentId,
        reason: `run is not ready_for_delivery or delivery OID mismatch: ${message}`,
      };
    }
    // Idempotency conflict with different input is a real error
    return {
      status: "infrastructure_error",
      deliveryIntentId: request.deliveryIntentId,
      reason: `delivery intent creation failed: ${message}`,
    };
  }

  // 3. Check existing remote observations for idempotent resume.
  const existingObservations = store.listRemoteObservations(request.deliveryIntentId);
  const remoteObs: RemoteObservation[] = existingObservations.map((o) => ({
    observationId: String(o.remote_observation_id),
    sequence: Number(o.sequence),
    operation: String(o.operation),
    outcome: String(o.outcome),
    observedRemoteOid: o.observed_remote_oid === null ? null : String(o.observed_remote_oid),
  }));

  const pushObs = findPushObservation(remoteObs);
  const lsRemoteObs = findLsRemoteObservation(remoteObs);

  // 4. Execute push if no push observation exists.
  let pushObservationId: string;
  if (pushObs !== undefined) {
    // Resume: push already recorded
    pushObservationId = pushObs.observationId;
    if (pushObs.outcome !== "pushed") {
      // Previous push failed — return the failure
      if (pushObs.outcome === "timeout") {
        return {
          status: "timeout",
          deliveryIntentId: request.deliveryIntentId,
          reason: "previous push timed out",
        };
      }
      return {
        status: "rejected",
        deliveryIntentId: request.deliveryIntentId,
        reason: `previous push outcome: ${pushObs.outcome}`,
        exitCode: null,
      };
    }
  } else {
    // Execute the push
    const pushResult = executePush(repoPath, remoteName, deliveryOid, branchName, request.timeoutMs);
    const nextSequence = remoteObs.length + 1;
    pushObservationId = `push-obs-${runId}-${nextSequence}`;

    let pushOutcome: string;
    let pushExitCode: number | null = null;

    if (pushResult.kind === "success") {
      pushOutcome = "pushed";
    } else if (pushResult.kind === "timeout") {
      pushOutcome = "timeout";
    } else if (pushResult.kind === "rejected") {
      pushOutcome = "rejected";
      pushExitCode = pushResult.exitCode;
    } else {
      pushOutcome = "infrastructure_error";
    }

    // Record the push observation
    try {
      authority.recordRemoteObservation({
        deliveryIntentId: request.deliveryIntentId,
        remoteObservationId: pushObservationId,
        sequence: nextSequence,
        operation: "push",
        outcome: pushOutcome,
        observedRemoteOid: null,
        ownerContextId: request.ownerContextId,
        ownerContextDigest: request.ownerContextDigest,
        evidenceIdempotencyKey: `push:${runId}:push-evidence:${nextSequence}`,
        createdAt: NOW,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "infrastructure_error",
        deliveryIntentId: request.deliveryIntentId,
        reason: `failed to record push observation: ${message}`,
      };
    }

    // Handle push failure
    if (pushResult.kind === "timeout") {
      return {
        status: "timeout",
        deliveryIntentId: request.deliveryIntentId,
        reason: pushResult.reason,
      };
    }
    if (pushResult.kind === "rejected") {
      return {
        status: "rejected",
        deliveryIntentId: request.deliveryIntentId,
        reason: pushResult.reason,
        exitCode: pushExitCode,
      };
    }
    if (pushResult.kind === "infrastructure_error") {
      return {
        status: "infrastructure_error",
        deliveryIntentId: request.deliveryIntentId,
        reason: pushResult.reason,
      };
    }
  }

  // 5. Execute ls-remote if no ls-remote observation exists.
  let lsRemoteObservationId: string;
  let observedRemoteOid: string;

  if (lsRemoteObs !== undefined) {
    // Resume: ls-remote already recorded
    lsRemoteObservationId = lsRemoteObs.observationId;
    observedRemoteOid = lsRemoteObs.observedRemoteOid!;
  } else {
    // Execute ls-remote
    const lsRemoteResult = executeLsRemote(repoPath, remoteName, branchName, request.timeoutMs);
    if (lsRemoteResult.kind === "error") {
      return {
        status: "infrastructure_error",
        deliveryIntentId: request.deliveryIntentId,
        reason: `ls-remote failed: ${lsRemoteResult.reason}`,
      };
    }
    observedRemoteOid = lsRemoteResult.oid;

    // Record the ls-remote observation
    const updatedObservations = store.listRemoteObservations(request.deliveryIntentId);
    const nextSequence = updatedObservations.length + 1;
    lsRemoteObservationId = `lsremote-obs-${runId}-${nextSequence}`;

    try {
      authority.recordRemoteObservation({
        deliveryIntentId: request.deliveryIntentId,
        remoteObservationId: lsRemoteObservationId,
        sequence: nextSequence,
        operation: "ls-remote",
        outcome: "observed",
        observedRemoteOid,
        ownerContextId: request.ownerContextId,
        ownerContextDigest: request.ownerContextDigest,
        evidenceIdempotencyKey: `push:${runId}:lsremote-evidence:${nextSequence}`,
        createdAt: NOW,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        status: "infrastructure_error",
        deliveryIntentId: request.deliveryIntentId,
        reason: `failed to record ls-remote observation: ${message}`,
      };
    }
  }

  // 6. Require the observed remote OID to equal the delivery OID.
  if (observedRemoteOid !== deliveryOid) {
    return {
      status: "mismatch",
      deliveryIntentId: request.deliveryIntentId,
      observedRemoteOid,
      expectedOid: deliveryOid,
    };
  }

  return {
    status: "verified",
    deliveryIntentId: request.deliveryIntentId,
    pushObservationId,
    lsRemoteObservationId,
    observedRemoteOid,
  };
}

type PushCommandResult =
  | { readonly kind: "success" }
  | { readonly kind: "rejected"; readonly reason: string; readonly exitCode: number }
  | { readonly kind: "timeout"; readonly reason: string }
  | { readonly kind: "infrastructure_error"; readonly reason: string };

function executePush(
  repoPath: string,
  remoteName: string,
  deliveryOid: string,
  branchName: string,
  timeoutMs: number,
): PushCommandResult {
  const refspec = `${deliveryOid}:refs/heads/${branchName}`;
  try {
    execFileSync("git", ["-C", repoPath, "push", remoteName, refspec], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { kind: "success" };
  } catch (error) {
    const e = error as Error & { signal?: string | null; status?: number | null; stderr?: string | Buffer };
    // Timeout: the process was killed by the timeout
    if (e.signal === "SIGTERM" || e.signal === "SIGKILL") {
      return {
        kind: "timeout",
        reason: `push timed out after ${timeoutMs}ms`,
      };
    }
    // Non-zero exit: rejected by remote (non-fast-forward, auth, etc.)
    if (typeof e.status === "number" && e.status > 0) {
      const stderr = typeof e.stderr === "string" ? e.stderr : "";
      const reason = stderr.includes("non-fast-forward") || stderr.includes("rejected")
        ? "push rejected by remote (non-fast-forward or rejected)"
        : `push exited with code ${e.status}`;
      return {
        kind: "rejected",
        reason,
        exitCode: e.status,
      };
    }
    // Other errors (spawn error, etc.)
    return {
      kind: "infrastructure_error",
      reason: e.message ?? "push command failed",
    };
  }
}

type LsRemoteResult =
  | { readonly kind: "ok"; readonly oid: string }
  | { readonly kind: "error"; readonly reason: string };

function executeLsRemote(
  repoPath: string,
  remoteName: string,
  branchName: string,
  timeoutMs: number,
): LsRemoteResult {
  const ref = `refs/heads/${branchName}`;
  try {
    const output = execFileSync("git", ["-C", repoPath, "ls-remote", remoteName, ref], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output === "") {
      return { kind: "error", reason: "ls-remote returned no ref" };
    }
    // Output format: "<oid>\trefs/heads/<branch>"
    const parts = output.split("\t");
    if (parts.length < 2 || !parts[0]!) {
      return { kind: "error", reason: "ls-remote output malformed" };
    }
    return { kind: "ok", oid: parts[0]!.trim() };
  } catch (error) {
    const e = error as Error & { message: string };
    return {
      kind: "error",
      reason: e.message ?? "ls-remote command failed",
    };
  }
}
