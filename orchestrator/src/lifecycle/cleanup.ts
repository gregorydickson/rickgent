import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { canonicalJson } from "../contracts/ticket-contract.js";
import { snapshotAttemptCaller, type AttemptCallerSnapshot } from "../git/attempt-workspace.js";
import {
  type AttemptOwnershipGrant,
  type AttemptResourceClaimSnapshot,
  type LeaseAuthority,
} from "../state/leases.js";

const CLEANUP_RECEIPT_AUTHORITY = Symbol("rickgent.cleanup-receipt-authority");
const AUTHORIZED_CLEANUP_RECEIPTS = new WeakSet<object>();
const GIT = "/usr/bin/git";

export type CleanupDisposition = "released";

export interface CleanupClaimPreimage {
  readonly resourceClaimId: string;
  readonly slot: AttemptResourceClaimSnapshot["slot"];
  readonly expectedState: "cleanup_pending";
  readonly expectedVersion: number;
}

interface CleanupReceiptInput {
  readonly attemptId: string;
  readonly ownershipId: string;
  readonly ownerGeneration: number;
  readonly ownershipContextDigest: string;
  readonly expectedOwnershipVersion: number;
  readonly disposition: CleanupDisposition;
  readonly proofDigest: `sha256:${string}`;
  readonly claims: readonly CleanupClaimPreimage[];
  readonly processReceiptId: string;
  readonly groupDeathEvidenceId: string;
  readonly salvageRecordId: string;
  readonly contextId: string;
  readonly deliveryRef: string;
  readonly deliveryObservedOid: string;
  readonly callerBefore: AttemptCallerSnapshot;
  readonly callerAfter: AttemptCallerSnapshot;
}

/** Runtime-unforgeable proof passed from CleanupService to LeaseAuthority. */
export class CleanupDispositionReceipt implements CleanupReceiptInput {
  readonly attemptId!: string;
  readonly ownershipId!: string;
  readonly ownerGeneration!: number;
  readonly ownershipContextDigest!: string;
  readonly expectedOwnershipVersion!: number;
  readonly disposition!: CleanupDisposition;
  readonly proofDigest!: `sha256:${string}`;
  readonly claims: readonly CleanupClaimPreimage[];
  readonly processReceiptId!: string;
  readonly groupDeathEvidenceId!: string;
  readonly salvageRecordId!: string;
  readonly contextId!: string;
  readonly deliveryRef!: string;
  readonly deliveryObservedOid!: string;
  readonly callerBefore!: AttemptCallerSnapshot;
  readonly callerAfter!: AttemptCallerSnapshot;

  constructor(authority: symbol, input: CleanupReceiptInput) {
    if (authority !== CLEANUP_RECEIPT_AUTHORITY) {
      throw new TypeError("cleanup receipts can only be minted by CleanupService");
    }
    Object.assign(this, input);
    this.claims = Object.freeze(input.claims.map((claim) => Object.freeze({ ...claim })));
    AUTHORIZED_CLEANUP_RECEIPTS.add(this);
    Object.freeze(this);
  }
}

export function isAuthorizedCleanupReceipt(value: unknown): value is CleanupDispositionReceipt {
  return typeof value === "object" && value !== null && AUTHORIZED_CLEANUP_RECEIPTS.has(value);
}

export interface CleanupRequest {
  readonly ownership: AttemptOwnershipGrant;
  readonly callerRepository: string;
  readonly callerBefore: AttemptCallerSnapshot;
  readonly processReceiptId: string;
  readonly groupDeathEvidenceId: string;
  readonly salvageRecordId: string;
  readonly contextId: string;
  /** Exact allowed attempt-ref postimage, normally the attributed t20 commit. */
  readonly expectedAttemptRefOid: string;
  readonly idempotencyKey: string;
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync(GIT, ["-c", "core.hooksPath=/dev/null", "-C", repo, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_NOGLOB_PATHSPECS: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  }).trim();
}

function gitRef(repo: string, ref: string): string | null {
  try {
    return git(repo, ["rev-parse", "--verify", "--quiet", ref]);
  } catch (error) {
    const status = (error as NodeJS.ErrnoException & { status?: number }).status;
    if (status === 1) return null;
    throw error;
  }
}

function registeredWorktrees(repo: string): readonly string[] {
  return git(repo, ["worktree", "list", "--porcelain", "-z"])
    .split("\0")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function sameCaller(left: AttemptCallerSnapshot, right: AttemptCallerSnapshot): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function assertCleanupPreimage(ownership: AttemptOwnershipGrant): void {
  if (ownership.ownership.state !== "cleanup_pending") {
    throw new Error("cleanup requires cleanup_pending ownership");
  }
  if (ownership.resources.some((claim) => claim.state !== "cleanup_pending")) {
    throw new Error("cleanup requires every attempt resource claim to be cleanup_pending");
  }
}

function snapshotAuthorizedCaller(request: CleanupRequest, ownership: AttemptOwnershipGrant): AttemptCallerSnapshot {
  const requestedRepository = realpathSync.native(request.callerRepository);
  if (requestedRepository !== ownership.repositoryPath) {
    throw new Error("cleanup caller repository differs from its authority-bound repository");
  }
  const observed = snapshotAttemptCaller(ownership.repositoryPath, ownership.gitCommonDirectory);
  if (!sameCaller(request.callerBefore, observed)) {
    throw new Error("cleanup caller preimage differs from the authority-bound repository");
  }
  return observed;
}

function assertStrictDescendant(root: string, path: string, label: string): void {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escaped the attempt allocation root`);
  }
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function removeOwnedPath(allocationRoot: string, path: string, label: string): void {
  assertStrictDescendant(allocationRoot, path, label);
  const info = lstatIfPresent(path);
  if (info === null) return;
  const parent = dirname(path);
  if (realpathSync.native(parent) !== parent) {
    throw new Error(`${label} parent is not canonical`);
  }
  if (info.isSymbolicLink()) throw new Error(`${label} was replaced by a symbolic link`);
  if (info.isFile()) {
    unlinkSync(path);
    return;
  }
  if (info.isDirectory()) {
    rmdirSync(path);
    return;
  }
  throw new Error(`${label} is not a removable regular file or empty directory`);
}

function cleanupClaims(ownership: AttemptOwnershipGrant): readonly CleanupClaimPreimage[] {
  return Object.freeze(ownership.resources.map((claim): CleanupClaimPreimage => Object.freeze({
    resourceClaimId: claim.resourceClaimId,
    slot: claim.slot,
    expectedState: "cleanup_pending",
    expectedVersion: claim.stateVersion,
  })));
}

function cleanupReceipt(
  request: CleanupRequest,
  ownership: AttemptOwnershipGrant,
  deliveryObservedOid: string,
  callerAfter: AttemptCallerSnapshot,
): CleanupDispositionReceipt {
  const claims = cleanupClaims(ownership);
  const proof = {
    schema_version: "rickgent.cleanup-proof.v1",
    attempt_id: ownership.attemptId,
    ownership_id: ownership.ownership.ownershipId,
    owner_generation: ownership.ownership.generation,
    ownership_context_digest: ownership.ownership.contextDigest,
    process_receipt_id: request.processReceiptId,
    group_death_evidence_id: request.groupDeathEvidenceId,
    salvage_record_id: request.salvageRecordId,
    context_id: request.contextId,
    delivery_ref: ownership.plan.lineage.deliveryRef,
    delivery_oid: deliveryObservedOid,
    caller_before: request.callerBefore,
    caller_after: callerAfter,
    claims,
  };
  return new CleanupDispositionReceipt(CLEANUP_RECEIPT_AUTHORITY, {
    attemptId: ownership.attemptId,
    ownershipId: ownership.ownership.ownershipId,
    ownerGeneration: ownership.ownership.generation,
    ownershipContextDigest: ownership.ownership.contextDigest,
    expectedOwnershipVersion: ownership.ownership.stateVersion,
    disposition: "released",
    proofDigest: sha256(proof),
    claims,
    processReceiptId: request.processReceiptId,
    groupDeathEvidenceId: request.groupDeathEvidenceId,
    salvageRecordId: request.salvageRecordId,
    contextId: request.contextId,
    deliveryRef: ownership.plan.lineage.deliveryRef,
    deliveryObservedOid,
    callerBefore: request.callerBefore,
    callerAfter,
  });
}

function effectsAreAbsent(ownership: AttemptOwnershipGrant): boolean {
  return lstatIfPresent(ownership.plan.allocationRoot) === null &&
    gitRef(ownership.repositoryPath, ownership.plan.attemptRef) === null &&
    !registeredWorktrees(ownership.repositoryPath).includes(ownership.plan.worktreePath);
}

function observedDelivery(ownership: AttemptOwnershipGrant): string {
  const observed = git(ownership.repositoryPath, ["rev-parse", "--verify", ownership.plan.lineage.deliveryRef]);
  if (observed !== ownership.plan.lineage.deliveryBaselineOid) {
    throw new Error("delivery ref changed during cleanup");
  }
  return observed;
}

/**
 * Performs only attempt-owned destructive effects. Any ambiguity throws while
 * the lease remains cleanup_pending; callers cannot turn a partial cleanup into
 * a release receipt.
 */
export class CleanupService {
  readonly #leases: LeaseAuthority;

  constructor(leases: LeaseAuthority) {
    this.#leases = leases;
  }

  execute(request: CleanupRequest): AttemptOwnershipGrant {
    assertCleanupPreimage(request.ownership);
    snapshotAuthorizedCaller(request, request.ownership);
    let ownership: AttemptOwnershipGrant;
    try {
      ownership = this.#leases.assertCleanupReady({
        ownership: request.ownership,
        processReceiptId: request.processReceiptId,
        groupDeathEvidenceId: request.groupDeathEvidenceId,
        salvageRecordId: request.salvageRecordId,
        expectedAttemptRefOid: request.expectedAttemptRefOid,
        idempotencyKey: `cleanup-ready:${sha256(request.idempotencyKey).slice("sha256:".length)}`,
      });
    } catch (readinessError) {
      // A post-COMMIT/pre-return crash leaves only the exact terminal physical
      // image. Reconstruct the same branded receipt and ask Store for the
      // immutable idempotent result; any different input still fails there.
      if (!effectsAreAbsent(request.ownership)) throw readinessError;
      const callerAfter = snapshotAuthorizedCaller(request, request.ownership);
      const receipt = cleanupReceipt(request, request.ownership, observedDelivery(request.ownership), callerAfter);
      try {
        const replay = this.#leases.finalizeCleanup({
          ownership: request.ownership,
          receipt,
          idempotencyKey: request.idempotencyKey,
        });
        if (replay.ownership.state !== "released" || replay.currentOwnership.state !== "released") {
          throw new Error("cleanup terminal replay did not resolve to the released image");
        }
        return replay;
      } catch {
        throw readinessError;
      }
    }
    assertCleanupPreimage(ownership);
    const plan = ownership.plan;
    const deliveryBefore = git(ownership.repositoryPath, ["rev-parse", "--verify", plan.lineage.deliveryRef]);
    if (deliveryBefore !== plan.lineage.deliveryBaselineOid) {
      throw new Error("delivery ref changed before cleanup");
    }
    const attemptOid = gitRef(ownership.repositoryPath, plan.attemptRef);
    if (attemptOid !== null && attemptOid !== request.expectedAttemptRefOid && attemptOid !== plan.lineage.deliveryBaselineOid) {
      throw new Error("attempt ref has a foreign postimage");
    }

    // Revalidate the token-bound owner immediately before the first effect.
    ownership = this.#leases.assertFresh(ownership);
    const worktrees = registeredWorktrees(ownership.repositoryPath);
    if (worktrees.includes(plan.worktreePath)) {
      git(ownership.repositoryPath, ["worktree", "remove", "--force", plan.worktreePath]);
    } else if (existsSync(plan.worktreePath)) {
      throw new Error("attempt worktree exists without its owned Git registration");
    }
    if (attemptOid !== null) {
      ownership = this.#leases.assertFresh(ownership);
      git(ownership.repositoryPath, ["update-ref", "-d", plan.attemptRef, attemptOid]);
    }
    for (const [label, path] of [
      ["isolated index", plan.isolatedIndexPath],
      ["policy context", plan.policyContextPath],
      ["policy bundle", plan.policyBundlePath],
      ["stdout", plan.stdoutPath],
      ["stderr", plan.stderrPath],
      ["verification output", plan.verificationOutputPath],
    ] as const) {
      ownership = this.#leases.assertFresh(ownership);
      removeOwnedPath(plan.allocationRoot, path, label);
    }
    for (const [label, path] of [
      ["policy directory", dirname(plan.policyContextPath)],
      ["output directory", dirname(plan.stdoutPath)],
    ] as const) {
      ownership = this.#leases.assertFresh(ownership);
      removeOwnedPath(plan.allocationRoot, path, label);
    }
    const allocationRoot = lstatIfPresent(plan.allocationRoot);
    if (allocationRoot !== null) {
      ownership = this.#leases.assertFresh(ownership);
      if (realpathSync.native(dirname(plan.allocationRoot)) !== dirname(plan.allocationRoot)) {
        throw new Error("allocation root parent is not canonical");
      }
      if (allocationRoot.isSymbolicLink() || !allocationRoot.isDirectory()) throw new Error("allocation root identity changed");
      rmdirSync(plan.allocationRoot);
    }

    const deliveryAfter = git(ownership.repositoryPath, ["rev-parse", "--verify", plan.lineage.deliveryRef]);
    const callerAfter = snapshotAuthorizedCaller(request, ownership);
    if (deliveryAfter !== deliveryBefore) throw new Error("delivery ref changed during cleanup");
    if (!sameCaller(request.callerBefore, callerAfter)) throw new Error("caller worktree changed during cleanup");
    if (lstatIfPresent(plan.allocationRoot) !== null) throw new Error("allocation resources remain after cleanup");
    if (gitRef(ownership.repositoryPath, plan.attemptRef) !== null) throw new Error("attempt ref remains after cleanup");
    if (registeredWorktrees(ownership.repositoryPath).includes(plan.worktreePath)) {
      throw new Error("attempt worktree registration remains after cleanup");
    }

    const receipt = cleanupReceipt(request, ownership, deliveryAfter, callerAfter);
    return this.#leases.finalizeCleanup({
      ownership,
      receipt,
      idempotencyKey: request.idempotencyKey,
    });
  }
}
